// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, you can obtain one at https://mozilla.org/MPL/2.0/.

'use strict'

const crypto = require('crypto')
const Promise = require('bluebird')
const sqs = require('sqs')

const EVENTS = {
  BOUNCE: 'bounce',
  DELIVERED: 'delivered',
  DROPPED: 'dropped',
  SPAM: 'spamreport'
}

const { AUTH, SQS_SUFFIX } = process.env

if (! AUTH || ! SQS_SUFFIX) {
  throw new Error('Missing config')
}

const AUTH_HASH = createHash(AUTH).split('')

const QUEUES = {
  Bounce: `fxa-email-bounce-${SQS_SUFFIX}`,
  Complaint: `fxa-email-complaint-${SQS_SUFFIX}`,
  Delivery: `fxa-email-delivery-${SQS_SUFFIX}`
}

// env vars: SQS_ACCESS_KEY, SQS_SECRET_KEY, SQS_REGION
const SQS_CLIENT = sqs()
SQS_CLIENT.pushAsync = Promise.promisify(SQS_CLIENT.push)

module.exports = { main }

async function main (data) {
  try {
    // If there's a body, it's a request from the API gateway
    if (data.body) {
      // Requests from the API gateway must be authenticated
      if (! data.queryStringParameters || ! authenticate(data.queryStringParameters.auth)) {
        return {
          statusCode: 401,
          body: 'Unauthorized',
          isBase64Encoded: false
        }
      }

      data = JSON.parse(data.body)
    }

    if (! Array.isArray(data)) {
      data = [ data ]
    }

    let results = await processEvents(data)
    return {
      statusCode: 200,
      body: `Processed ${results.length} events`,
      isBase64Encoded: false
    }
  } catch(error) {
    return {
      statusCode: 500,
      body: 'Internal Server Error',
      isBase64Encoded: false
    }
  }
}

function authenticate (auth) {
  const authHash = createHash(auth)
  return AUTH_HASH
    .reduce((equal, char, index) => equal && char === authHash[index], true)
}

function createHash (value) {
  const hash = crypto.createHash('sha256')
  hash.update(value)
  return hash.digest('base64')
}

async function processEvents (events) {
  return Promise.all(
    events.map(marshallEvent)
      .filter(event => !! event)
      .map(sendEvent)
  )
}

function marshallEvent (event) {
  if (! event || ! event.timestamp || ! event.sg_message_id || ! event.event) {
    return
  }

  const timestamp = mapTimestamp(event.timestamp)
  const mail = marshallMailObject(event, timestamp)

  switch (event.event) {
    case EVENTS.BOUNCE:
    case EVENTS.DROPPED:
      return { mail, ...marshallBounceEvent(event, timestamp) }

    case EVENTS.DELIVERED:
      return { mail, ...marshallDeliveryEvent(event, timestamp) }

    case EVENTS.SPAM:
      return { mail, ...marshallComplaintEvent(event, timestamp) }
  }
}

function mapTimestamp (timestamp) {
  return new Date(timestamp * 1000).toISOString()
}

function marshallMailObject (event, timestamp) {
  // Although I haven't seen it documented explicitly, sg_message_id appears to be
  // the message id that Sendgrid returned from the call to `send`, appended with
  // some stuff that begins with the string ".filter". This step just ensures we
  // strip off the extra stuff.
  //
  // Example input: 14c5d75ce93.dfd.64b469.filter0001.16648.5515E0B88.0
  // Example output: 14c5d75ce93.dfd.64b469
  const messageId = event.sg_message_id.split('.filter')[0]

  return {
    timestamp,
    messageId
  }
}

function marshallBounceEvent (event, timestamp) {
  let bounceType, bounceSubType

  if (event.event === EVENTS.DROPPED) {
    bounceType = 'Permanent'
    bounceSubType = 'Suppressed'
  } else {
    // These status mappings aren't perfect but they're good enough. See
    // the RFCs and the IANA registry for all the gory detail on statuses:
    //
    //   * https://tools.ietf.org/html/rfc5248
    //   * https://tools.ietf.org/html/rfc3463
    //   * https://www.iana.org/assignments/smtp-enhanced-status-codes/smtp-enhanced-status-codes.xhtml
    const statusParts = event.status && event.status.split('.')
    if (statusParts && statusParts.length === 3) {
      if (statusParts[0] === '5') {
        bounceType = 'Permanent'
      }

      bounceSubType = mapStatusToBounceSubType(statusParts)
    }
  }

  return {
    notificationType: 'Bounce',
    bounce: {
      bounceType: bounceType || 'Transient',
      bounceSubType: bounceSubType || 'General',
      bouncedRecipients: [
        { emailAddress: event.email }
      ],
      timestamp,
      feedbackId: event.sg_event_id
    }
  }
}

function mapStatusToBounceSubType (statusParts) {
  switch (statusParts[1]) {
    case '1':
      return 'NoEmail'

    case '2':
      switch (statusParts[2]) {
        case '2':
          return 'MailboxFull'

        case '3':
          return 'MessageTooLarge'
      }
      break

    case '6':
      return 'ContentRejected'
  }
}

function marshallDeliveryEvent (event, timestamp) {
  return {
    notificationType: 'Delivery',
    delivery: {
      timestamp,
      recipients: [ event.email ],
      smtpResponse: event.response
    }
  }
}

function marshallComplaintEvent (event, timestamp) {
  return {
    notificationType: 'Complaint',
    complaint: {
      complainedRecipients: [
        { emailAddress: event.email }
      ],
      timestamp,
      feedbackId: event.sg_event_id
    }
  }
}

function sendEvent (event) {
  return SQS_CLIENT.pushAsync(QUEUES[event.notificationType], event)
    .then(() => console.log('Sent:', event.notificationType))
    .catch(error => {
      console.error('Failed to send event:', event)
      console.error(error.stack)
      throw error
    })
}
