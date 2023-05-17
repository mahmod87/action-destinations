/* eslint-disable @typescript-eslint/no-unsafe-call */
import { Liquid as LiquidJs } from 'liquidjs'
import type { Settings } from '../generated-types'
import type { Payload as SmsPayload } from '../sendSms/generated-types'
import type { Payload as WhatsappPayload } from '../sendWhatsApp/generated-types'
import { IntegrationError, RequestOptions } from '@segment/actions-core'
import { Logger, StatsClient, StatsContext } from '@segment/actions-core/src/destination-kit'
import { ExecuteInput } from '@segment/actions-core'
import { ContentTemplateResponse, ContentTemplateTypes, Profile, TwilioApiError } from './types'

const Liquid = new LiquidJs()

export type RequestFn = (url: string, options?: RequestOptions) => Promise<Response>

export abstract class MessageSender<MessagePayload extends SmsPayload | WhatsappPayload> {
  // private readonly EXTERNAL_ID_KEY = 'phone'
  // private readonly DEFAULT_HOSTNAME = 'api.twilio.com'
  // private readonly DEFAULT_CONNECTION_OVERRIDES = 'rp=all&rc=5'
  static nonSendableStatuses = ['unsubscribed', 'did not subscribed', 'false'] // do we need that??
  static sendableStatuses = ['subscribed', 'true']
  protected readonly supportedTemplateTypes: string[]

  constructor(
    readonly request: RequestFn,
    readonly payload: MessagePayload,
    readonly settings: Settings,
    readonly statsClient: StatsClient | undefined,
    readonly tags: StatsContext['tags'],
    readonly logger: Logger | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly executeInput: ExecuteInput<Settings, MessagePayload>,
    readonly logDetails: Record<string, unknown> = {}
  ) {}

  abstract getChannelType(): string

  /*
   * takes an object full of content containing liquid traits, renders it, and returns it in the same shape
   */
  async parseContent<R extends Record<string, string | string[] | undefined>>(
    content: R,
    profile: Profile
  ): Promise<R> {
    try {
      const parsedEntries = await Promise.all(
        Object.entries(content).map(async ([key, val]) => {
          if (val == null) {
            return [key, val]
          }

          if (Array.isArray(val)) {
            val = await Promise.all(val.map((item) => Liquid.parseAndRender(item, { profile })))
          } else {
            val = await Liquid.parseAndRender(val, { profile })
          }
          return [key, val]
        })
      )

      return Object.fromEntries(parsedEntries)
    } catch (error: unknown) {
      this.logDetails['error'] = error instanceof Error ? error.message : error?.toString()
      this.logError(`${this.getChannelType()} liquid template parsing failure - ${this.settings.spaceId}`)
      throw new IntegrationError(
        `Unable to parse liquid templating in ${this.getChannelType()}`,
        `${this.getChannelType()} liquid templating parse failure`,
        400
      )
    }
  }

  /**
   * check if the externalId object is supported for sending a message
   * @param externalId
   * @returns
   */
  isValidExternalId(externalId: NonNullable<MessagePayload['externalIds']>[number]): boolean {
    return externalId.type === 'phone' && this.getChannelType() === externalId.channelType?.toLowerCase()
  }

  redactPii(pii: string | undefined) {
    if (!pii) {
      return pii
    }

    if (pii.length <= 8) {
      return '***'
    }
    return pii.substring(0, 3) + '***' + pii.substring(pii.length - 3)
  }

  logInfo(...msgs: string[]) {
    const [firstMsg, ...rest] = msgs
    this.logger?.info(`TE Messaging: ${firstMsg}`, ...rest, JSON.stringify(this.logDetails))
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  logError(error?: any, ...msgs: string[]) {
    const [firstMsg, ...rest] = msgs
    if (typeof error === 'string') {
      this.logger?.error(`TE Messaging: ${error}`, ...msgs, JSON.stringify(this.logDetails))
    } else {
      this.logger?.error(
        `TE Messaging: ${firstMsg}`,
        ...rest,
        error instanceof Error ? error.message : error?.toString(),
        JSON.stringify(this.logDetails)
      )
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static isPromise<T = unknown>(obj: unknown): obj is Promise<T> {
    // `obj instanceof Promise` is not reliable since it can be a custom promise object from fetch lib
    //https://stackoverflow.com/questions/27746304/how-to-check-if-an-object-is-a-promise

    // for whatever reason it gave me error "Property 'then' does not exist on type 'never'." so i have to use ts-ignore
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    return obj instanceof Object && 'then' in obj && typeof obj.then === 'function'
  }

  logWrap<R = void>(messages: string[], fn: () => R): R {
    this.logInfo('Starting: ', ...messages)
    try {
      const res = fn()
      if (MessageSender.isPromise(res)) {
        return (async () => {
          try {
            const promisedRes = await res
            this.logInfo('Success: ', ...messages)
            return promisedRes
          } catch (error: unknown) {
            this.logError(error, 'Failed: ', ...messages)
            throw error
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })() as any as R // cast to R otherwise ts is not happy
      }
      this.logInfo('Success: ', ...messages)
      return res
    } catch (error: unknown) {
      this.logError(error, 'Failed: ', ...messages)
      throw error
    }
  }

  /**
   * populate the logDetails object with the data that should be logged for every message
   */
  initLogDetails() {
    //overrideable
    Object.assign(this.logDetails, {
      externalIds: this.payload.externalIds?.map((eid) => ({ ...eid, id: this.redactPii(eid.id) })),
      shouldSend: this.payload.send,
      contentSid: this.payload.contentSid,
      sourceId: this.settings.sourceId,
      spaceId: this.settings.spaceId,
      twilioApiKeySID: this.settings.twilioApiKeySID,
      region: this.settings.region,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messageId: (this.executeInput as any)['rawData']?.messageId, // undocumented, not recommended way used here for tracing retries in logs https://github.com/segmentio/action-destinations/blob/main/packages/core/src/destination-kit/action.ts#L141
      channelType: this.getChannelType()
    })
    if ('userId' in this.payload) this.logDetails.userId = this.payload.userId
  }

  async getContentTemplateTypes(): Promise<ContentTemplateTypes> {
    let template
    try {
      if (!this.payload.contentSid) {
        throw new Error('Content SID not in payload')
      }

      this.logInfo('Get content template from Twilio by ContentSID')

      const twilioToken = Buffer.from(`${this.settings.twilioApiKeySID}:${this.settings.twilioApiKeySecret}`).toString(
        'base64'
      )
      const response = await this.request(`https://content.twilio.com/v1/Content/${this.payload.contentSid}`, {
        method: 'GET',
        headers: {
          authorization: `Basic ${twilioToken}`
        }
      })

      template = (await response.json()) as ContentTemplateResponse
    } catch (error) {
      this.tags.push('reason:get_content_template')
      this.statsClient?.incr('actions-personas-messaging-twilio.error', 1, this.tags)
      this.logError(
        `${this.getChannelType()} failed request to fetch content template from Twilio Content API - ${
          this.settings.spaceId
        } - ${error}, ${JSON.stringify(error)})}`
      )
      throw new IntegrationError('Unable to fetch content template', 'Twilio Content API request failure', 500)
    }

    return this.extractTemplateTypes(template)
  }

  private extractTemplateTypes(template: ContentTemplateResponse): ContentTemplateTypes {
    if (!template.types) {
      this.logError(
        `${this.getChannelType()} template from Twilio Content API does not contain a template type - ${
          this.settings.spaceId
        } - [${JSON.stringify(template)}]`
      )
      throw new IntegrationError(
        'Unexpected response from Twilio Content API',
        `${this.getChannelType()} template does not contain a template type`,
        500
      )
    }
    const type = Object.keys(template.types)[0] // eg 'twilio/text', 'twilio/media', etc
    if (this.supportedTemplateTypes.includes(type)) {
      return { body: template.types[type].body, media: template.types[type].media }
    } else {
      this.logError(`${this.getChannelType()} unsupported content template type '${type}' - ${this.settings.spaceId}`)
      throw new IntegrationError(
        'Unsupported content type',
        `Sending templates with '${type}' content type is not supported by ${this.getChannelType()}`,
        400
      )
    }
  }

  getWebhookUrlWithParams(
    externalIdType?: string,
    externalIdValue?: string,
    defaultConnectionOverrides = 'rp=all&rc=5'
  ): string | null {
    const webhookUrl = this.settings.webhookUrl
    const connectionOverrides = this.settings.connectionOverrides
    const customArgs: Record<string, string | undefined> = {
      ...this.payload.customArgs,
      space_id: this.settings.spaceId,
      __segment_internal_external_id_key__: externalIdType,
      __segment_internal_external_id_value__: externalIdValue
    }

    if (webhookUrl && customArgs) {
      // Webhook URL parsing has a potential of failing. I think it's better that
      // we fail out of any invocation than silently not getting analytics
      // data if that's what we're expecting.
      const webhookUrlWithParams = new URL(webhookUrl)
      for (const key of Object.keys(customArgs)) {
        webhookUrlWithParams.searchParams.append(key, String(customArgs[key]))
      }

      webhookUrlWithParams.hash = connectionOverrides || defaultConnectionOverrides

      return webhookUrlWithParams.toString()
    }

    return null
  }

  logTwilioError(error: unknown): unknown {
    let errorToRethrow = error
    if (error instanceof Object) {
      const twilioApiError = error as TwilioApiError
      this.logDetails['twilioApiError_response_data'] = twilioApiError.response?.data
      this.logDetails['twilio-request-id'] = twilioApiError.response?.headers?.get('twilio-request-id')
      this.logDetails['error'] = twilioApiError.response

      this.logError(`Twilio API error - ${this.settings.spaceId}`)
      const statusCode = twilioApiError.status || twilioApiError.response?.data?.status
      this.tags.push(`twilio_status_code:${statusCode}`)
      this.statsClient?.incr('actions_personas_messaging_twilio.response', 1, this.tags)

      if (!twilioApiError.status) {
        //to handle error properly by Centrifuge
        errorToRethrow = new IntegrationError(
          twilioApiError.response?.data?.message || twilioApiError.message,
          (twilioApiError.response?.data?.code || statusCode)?.toString() || 'Twilio Api Request Error',
          statusCode
        )
      }

      const errorCode = twilioApiError.response?.data?.code
      if (errorCode === 63018 || statusCode === 429) {
        // Exceeded WhatsApp rate limit
        this.statsClient?.incr('actions_personas_messaging_twilio.rate_limited', 1, this.tags)
      }
    }
    return errorToRethrow
  }

  throwTwilioError(error: unknown) {
    throw this.logTwilioError(error)
  }
}
