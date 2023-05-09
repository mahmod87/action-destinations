/* eslint-disable @typescript-eslint/no-unsafe-call */
import type { Settings } from '../generated-types'
import type { Payload } from '../sendSms/generated-types'
import { IntegrationError } from '@segment/actions-core'
import { Logger, StatsClient, StatsContext } from '@segment/actions-core/src/destination-kit'
import { RequestFn } from './types'

enum SendabilityStatus {
  NoSenderPhone = 'no_sender_phone',
  ShouldSend = 'should_send',
  DoNotSend = 'do_not_send',
  SendDisabled = 'send_disabled',
  InvalidSubscriptionStatus = 'invalid_subscription_status'
}

interface TwilioApiError extends Error {
  response: {
    data: {
      code: number
      message: string
      more_info: string
      status: number
    },
    headers?: Response['headers'],
  },
  code?: number
  status?: number
}

type SendabilityPayload = { sendabilityStatus: SendabilityStatus; phone: string | undefined }

type MinimalPayload = Pick<
  Payload,
  'from' | 'toNumber' | 'customArgs' | 'externalIds' | 'traits' | 'send' | 'eventOccurredTS'
>

export abstract class MessageSender<SmsPayload extends MinimalPayload> {
  private readonly EXTERNAL_ID_KEY = 'phone'
  private readonly DEFAULT_HOSTNAME = 'api.twilio.com'
  private readonly DEFAULT_CONNECTION_OVERRIDES = 'rp=all&rc=5'

  constructor(
    readonly request: RequestFn,
    readonly payload: SmsPayload,
    readonly settings: Settings,
    readonly statsClient: StatsClient | undefined,
    readonly tags: StatsContext['tags'],
    readonly logger: Logger | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly logDetails: {[key:string]: any} = {}
  ) {
  }

  abstract getBody: (phone: string) => Promise<URLSearchParams>

  abstract getExternalId: () => NonNullable<MinimalPayload['externalIds']>[number] | undefined

  send = async () => {
    const { phone, sendabilityStatus } = this.getSendabilityPayload()

    if (sendabilityStatus !== SendabilityStatus.ShouldSend || !phone) {
      return
    }

    this.logger?.info("TE Messaging: getting content Body", JSON.stringify(this.logDetails))
    const body = await this.getBody(phone)

    const webhookUrlWithParams = this.getWebhookUrlWithParams(phone)

    if (webhookUrlWithParams) body.append('StatusCallback', webhookUrlWithParams)

    const twilioHostname = this.settings.twilioHostname ?? this.DEFAULT_HOSTNAME
    const twilioToken = Buffer.from(`${this.settings.twilioApiKeySID}:${this.settings.twilioApiKeySecret}`).toString(
      'base64'
    )
    try {
      this.logger?.info("TE Messaging: Sending message to Twilio API", JSON.stringify(this.logDetails))

      const response = await this.request(
        `https://${twilioHostname}/2010-04-01/Accounts/${this.settings.twilioAccountSID}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${twilioToken}`
          },
          body
        }
      )
      this.tags.push(`twilio_status_code:${response.status}`)
      this.statsClient?.incr('actions-personas-messaging-twilio.response', 1, this.tags)

      if (this.payload.eventOccurredTS != undefined) {
        this.statsClient?.histogram(
          'actions-personas-messaging-twilio.eventDeliveryTS',
          Date.now() - new Date(this.payload.eventOccurredTS).getTime(),
          this.tags
        )
      }

      this.logDetails['twilio-request-id'] = response.headers?.get('twilio-request-id')

      this.logger?.info("TE Messaging: Message sent successfully", JSON.stringify(this.logDetails))

      return response
    } catch (error: unknown) {
      if (error instanceof Object) {
        const twilioApiError = error as TwilioApiError
        this.logDetails['twilioApiError_response_data'] = twilioApiError.response.data
        this.logDetails['twilio-request-id'] = twilioApiError.response.headers?.get('twilio-request-id')
        this.logDetails['error'] = { status: twilioApiError.status, code: twilioApiError.code }

        this.logger?.error(
          `TE Messaging: Twilio Programmable API error - ${this.settings.spaceId} - [${JSON.stringify(this.logDetails)}]`
        )
        const errorCode = twilioApiError.response.data.code
        if (errorCode === 63018) {
          // Exceeded WhatsApp rate limit
          this.statsClient?.incr('actions-personas-messaging-twilio.rate-limited', 1, this.tags)
        }
      }
      // Bubble the error to integrations
      throw error
    }
  }

  private getSendabilityPayload = (): SendabilityPayload => {
    const nonSendableStatuses = ['unsubscribed', 'did not subscribed', 'false']
    const sendableStatuses = ['subscribed', 'true']
    const externalId = this.getExternalId()

    let status: SendabilityStatus

    if (!this.payload.send) {
      this.statsClient?.incr('actions-personas-messaging-twilio.send-disabled', 1, this.tags)
      return { sendabilityStatus: SendabilityStatus.SendDisabled, phone: undefined }
    }

    if (!externalId?.subscriptionStatus || nonSendableStatuses.includes(externalId.subscriptionStatus)) {
      this.statsClient?.incr('actions-personas-messaging-twilio.notsubscribed', 1, this.tags)
      status = SendabilityStatus.DoNotSend
    } else if (sendableStatuses.includes(externalId.subscriptionStatus)) {
      this.statsClient?.incr('actions-personas-messaging-twilio.subscribed', 1, this.tags)
      status = SendabilityStatus.ShouldSend
    } else {
      this.statsClient?.incr('actions-personas-messaging-twilio.twilio-error', 1, this.tags)
      throw new IntegrationError(
        `Failed to recognize the subscriptionStatus in the payload: "${externalId.subscriptionStatus}".`,
        'Invalid subscriptionStatus value',
        400
      )
    }

    const phone = this.payload.toNumber || externalId?.id
    if (!phone) {
      status = SendabilityStatus.NoSenderPhone
    }

    return { sendabilityStatus: status, phone }
  }

  private getWebhookUrlWithParams = (phone: string): string | null => {
    const webhookUrl = this.settings.webhookUrl
    const connectionOverrides = this.settings.connectionOverrides
    const customArgs: Record<string, string | undefined> = {
      ...this.payload.customArgs,
      space_id: this.settings.spaceId,
      __segment_internal_external_id_key__: this.EXTERNAL_ID_KEY,
      __segment_internal_external_id_value__: phone
    }

    if (webhookUrl && customArgs) {
      // Webhook URL parsing has a potential of failing. I think it's better that
      // we fail out of any invocation than silently not getting analytics
      // data if that's what we're expecting.
      const webhookUrlWithParams = new URL(webhookUrl)
      for (const key of Object.keys(customArgs)) {
        webhookUrlWithParams.searchParams.append(key, String(customArgs[key]))
      }

      webhookUrlWithParams.hash = connectionOverrides || this.DEFAULT_CONNECTION_OVERRIDES

      return webhookUrlWithParams.toString()
    }

    return null
  }
}
