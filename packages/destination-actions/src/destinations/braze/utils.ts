import { omit } from '@segment/actions-core'
import { IntegrationError, RequestClient } from '@segment/actions-core'
import dayjs from 'dayjs'
import { Settings } from './generated-types'
import { Payload } from './trackEvent/generated-types'
import action from './trackPurchase'
import { Payload as TrackPurchasePayload } from './trackPurchase/generated-types'
import { getUserAlias } from './userAlias'
type DateInput = string | Date | number | null | undefined
type DateOutput = string | undefined | null

function toISO8601(date: DateInput): DateOutput {
  if (date === null || date === undefined) {
    return date
  }

  const d = dayjs(date)
  return d.isValid() ? d.toISOString() : undefined
}
export function sendTrackEvent(request: RequestClient, settings: Settings, payloads: Payload[]) {
  const payload = payloads.map((payload) => {
    const { braze_id, external_id } = payload
    // Extract valid user_alias shape. Since it is optional (oneOf braze_id, external_id) we need to only include it if fully formed.
    const user_alias = getUserAlias(payload.user_alias)

    if (!braze_id && !user_alias && !external_id) {
      throw new IntegrationError(
        'One of "external_id" or "user_alias" or "braze_id" is required.',
        'Missing required fields',
        400
      )
    }
    return {
      braze_id,
      external_id,
      user_alias,
      app_id: settings.app_id,
      name: payload.name,
      time: toISO8601(payload.time),
      properties: payload.properties,
      _update_existing_only: payload._update_existing_only
    }
  })
  return request(`${settings.endpoint}/users/track`, {
    method: 'post',
    json: {
      events: payload
    }
  })
}
export function sendTrackPurchase(request: RequestClient, settings: Settings, payloads: TrackPurchasePayload[]) {
  const payload = payloads.map((payload) => {
    const { braze_id, external_id } = payload
    // Extract valid user_alias shape. Since it is optional (oneOf braze_id, external_id) we need to only include it if fully formed.
    const user_alias = getUserAlias(payload.user_alias)

    if (!braze_id && !user_alias && !external_id) {
      throw new IntegrationError(
        'One of "external_id" or "user_alias" or "braze_id" is required.',
        'Missing required fields',
        400
      )
    }

    // Skip when there are no products to send to Braze
    if (payload.products.length === 0) {
      return
    }

    const reservedKeys = Object.keys(action.fields.products.properties ?? {})
    const properties = omit(payload.properties, reservedKeys)
    const base = {
      braze_id,
      external_id,
      user_alias,
      app_id: settings.app_id,
      time: toISO8601(payload.time),
      properties,
      _update_existing_only: payload._update_existing_only
    }

    return payload.products.map((product) => ({
      ...base,
      product_id: product.product_id,
      currency: product.currency ?? 'USD',
      price: product.price,
      quantity: product.quantity
    }))
  })
  return request(`${settings.endpoint}/users/track`, {
    method: 'post',
    json: {
      purchases: payload
    }
  })
}