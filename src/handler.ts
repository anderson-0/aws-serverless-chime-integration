import ChimeSDKMediaPipelines from 'aws-sdk/clients/chime'
import { CloudWatchLogs, Chime, ChimeSDKMeetings, DynamoDB, Endpoint } from 'aws-sdk'
import { APIGatewayProxyCallback, APIGatewayProxyEvent, Context, SQSEvent } from 'aws-lambda'
import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { metricScope } from 'aws-embedded-metrics'

type Response = {
  statusCode: number,
  headers: {
    'Content-Type': string
  },
  body: any,
  isBase64Encoded: boolean,
}

type LogEvent = {
  message: string
  timestampMs: number
  logLevel?: string
  sequenceNumber?: number
}

type Log = {
  message: string
  timestamp: number
}

const STAGE = process.env.STAGE || 'dev'
const SQS_QUEUE_ARN = process.env.SQS_QUEUE_ARN

// Store meetings in a DynamoDB table so attendees can join by meeting title
const ddb = new DynamoDB();

// Set the AWS SDK Chime endpoint. The Chime endpoint is https://service.chime.amazon.com.
const endpoint = "https://service.chime.amazon.com";
const currentRegion = "us-east-1";
const useChimeSDKMeetings = 'true';
const chimeSDKMeetingsEndpoint = "https://service.chime.amazon.com";
const mediaPipelinesControlRegion = "us-east-1";
const useChimeSDKMediaPipelines = 'true';
const chimeSDKMediaPipelinesEndpoint = "https://media-pipelines-chime.us-east-1.amazoncom";
const dynamoDb = new DynamoDB();
const chime = new Chime({ region: currentRegion });
const cloudWatchClient = new CloudWatchLogs({ apiVersion: '2014-03-28' })
const chimeSDKMeetings = new ChimeSDKMeetings({ region: currentRegion });

// Create an AWS SDK Media Pipelines object.
const chimeSdkMediaPipelines = new ChimeSDKMediaPipelines({ region: mediaPipelinesControlRegion });

// Set the AWS SDK Chime endpoint. The Chime endpoint is https://service.chime.amazon.com.
chime.endpoint = new Endpoint(endpoint);

if (chimeSDKMeetingsEndpoint != 'https://service.chime.amazon.com' && useChimeSDKMeetings === 'true') {
  chimeSDKMeetings.endpoint = new Endpoint(chimeSDKMeetingsEndpoint);
}

if (useChimeSDKMediaPipelines === 'true') {
  chimeSdkMediaPipelines.endpoint = new Endpoint(chimeSDKMediaPipelinesEndpoint)
}

const MEETINGS_TABLE_NAME = `chime-meetings-${STAGE}`
const BROWSER_LOG_GROUP_NAME = `chime-meetings-browser-logs-${STAGE}`
const BROWSER_MEETING_EVENT_LOG_GROUP_NAME = `chime-meetings-browser-meetings-logs-${STAGE}`
const BROWSER_EVENT_INGESTION_LOG_GROUP_NAME = `chime-meetings-browser-event-ingestion-logs-${STAGE}`
const USE_EVENT_BRIDGE = 'false'

// return chime meetings SDK client just for Echo Reduction for now.
function getClientForMeeting(meeting: any): any {
  if (useChimeSDKMeetings === 'true') {
    return chimeSDKMeetings
  }
  if (meeting?.Meeting?.MeetingFeatures?.Audio?.EchoReduction === 'AVAILABLE') {
    return chimeSDKMeetings
  }
  return chime
}

function getClientForMediaCapturePipelines(): any {
  if (useChimeSDKMediaPipelines === 'true') {
    return chimeSdkMediaPipelines
  }
  return chime
}

// Retrieves the meeting from the table by the meeting title
async function getMeeting(title: string): Promise<any> {
  const result = await ddb.getItem({
    TableName: MEETINGS_TABLE_NAME,
    Key: {
      'Title': {
        S: title
      },
    },
  }).promise()
  return result.Item ? JSON.parse(result.Item.Data.S as any) : null
}

function apiResponse(statusCode: number, contentType: string, body: any, isBase64Encoded = false): Response {
  return {
    statusCode: statusCode,
    headers: { 'Content-Type': contentType },
    body: body,
    isBase64Encoded,
  }
}

function createLogStreamName(meetingId, attendeeId) {
  return `ChimeSDKMeeting_${meetingId}_${attendeeId}`
}

async function createLogStream(event: APIGatewayProxyEvent, logGroupName: string) {
  const body = JSON.parse(event.body || '{}')
  if (!body.meetingId || !body.attendeeId) {
    return apiResponse(400, 'application/json', JSON.stringify({
      error: 'Required properties: meetingId, attendeeId'
    }))
  }
  
  await cloudWatchClient.createLogStream({
    logGroupName,
    logStreamName: createLogStreamName(body.meetingId, body.attendeeId)
  }).promise()
  return apiResponse(200, 'application/json', JSON.stringify({}))
}

export async function createBrowserLogStream(event: APIGatewayProxyEvent) {
  return createLogStream(event, BROWSER_LOG_GROUP_NAME)
}

export async function createBrowserEventLogStream(event: APIGatewayProxyEvent){
  return createLogStream(event, BROWSER_MEETING_EVENT_LOG_GROUP_NAME)
}

export async function createBrowserEventIngestionLogStream(event: APIGatewayProxyEvent) {
  return createLogStream(event, BROWSER_EVENT_INGESTION_LOG_GROUP_NAME)
}

export async function index(event: APIGatewayProxyEvent) {
  console.log(SQS_QUEUE_ARN)
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html' },
    body: fs.readFileSync(path.join(__dirname, './index.html'), { encoding: 'utf8' })
  }
}

// Stores the meeting in the table using the meeting title as the key
export async function putMeeting(title: string, meeting: any) {
  // Stores the meeting in the table using the meeting title as the key
  await ddb.putItem({
    TableName: MEETINGS_TABLE_NAME,
    Item: {
      'Title': { S: title },
      'Data': { S: JSON.stringify(meeting) },
      'TTL': {
        N: `${Math.floor(Date.now() / 1000) + 60 * 60 * 24}` // clean up meeting record one day from now
      }
    }
  }).promise()
}

export async function join(event: APIGatewayProxyEvent, context: Context) {
  const meetingIdFormat = /^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/
  const query = event.queryStringParameters

  console.log(`fui chamado com o query: ${JSON.stringify(query)}`)

  if (!query) {
    return apiResponse(400, 'application/json', JSON.stringify({
      error: 'Required properties: title, name'
    }))
  }

  if (!query.title || !query.name) {
    return apiResponse(400, 'application/json', JSON.stringify({ error: 'Need parameters: title, name' }))
  }

  // Look up the meeting by its title
  let meeting = await getMeeting(query.title)

  let client = getClientForMeeting(meeting)

  let primaryMeeting
  if (query.primaryExternalMeetingId) {
    primaryMeeting = await getMeeting(query.primaryExternalMeetingId)
    if (primaryMeeting) {
      console.info(`Retrieved primary meeting ID ${primaryMeeting.Meeting.MeetingId} for external meeting ID ${query.primaryExternalMeetingId}`)
    } else if (meetingIdFormat.test(query.primaryExternalMeetingId)) {
      // Just in case, check if we were passed a regular meeting ID instead of an external ID
      try {
        primaryMeeting = await client.getMeeting({
          MeetingId: query.primaryExternalMeetingId
        }).promise()
        if (primaryMeeting !== undefined) {
          console.info(`Retrieved primary meeting id ${primaryMeeting.Meeting.MeetingId}`)
          await putMeeting(query.primaryExternalMeetingId, primaryMeeting)
        }
      } catch (error) {
        console.info("Meeting ID doesnt' exist as a conference ID: " + error)
      }
    }
    if (!primaryMeeting) {
      return apiResponse(400, 'application/json', JSON.stringify({ error: 'Primary meeting has not been created' }))
    }
  }

  if (!meeting) {
    if (!query.region) {
      return apiResponse(400, 'application/json', JSON.stringify({ error: 'Need region parameter set if meeting has not yet been created' }))
    }
    // If the meeting does not exist, check if we were passed in a meeting ID instead of an external meeting ID.  If so, use that one
    try {
      if (meetingIdFormat.test(query.title)) {
        meeting = await client.getMeeting({
          MeetingId: query.title
        }).promise()
      }
    } catch (error) {
      console.info("Meeting ID doesn't exist as a conference ID: " + error)
    }

    // If still no meeting, create one
    if (!meeting) {
      let request: any = {
        // Use a UUID for the client request token to ensure that any request retries
        // do not create multiple meetings.
        ClientRequestToken: uuidv4(),

        // Specify the media region (where the meeting is hosted).
        // In this case, we use the region selected by the user.
        MediaRegion: query.region,

        // Set up SQS notifications if being used
        NotificationsConfiguration: USE_EVENT_BRIDGE === 'false' ? { SqsQueueArn: SQS_QUEUE_ARN } : {},

        // Any meeting ID you wish to associate with the meeting.
        // For simplicity here, we use the meeting title.
        ExternalMeetingId: query.title.substring(0, 64),
      }
      if (primaryMeeting !== undefined) {
        request.PrimaryMeetingId = primaryMeeting.Meeting.MeetingId
      }
      if (query.ns_es === 'true') {
        client = chimeSDKMeetings
        request.MeetingFeatures = {
          Audio: {
            // The EchoReduction parameter helps the user enable and use Amazon Echo Reduction.
            EchoReduction: 'AVAILABLE'
          }
        }
      }
      console.info('Creating new meeting: ' + JSON.stringify(request))
      meeting = await client.createMeeting(request).promise()

      // Extend meeting with primary external meeting ID if it exists
      if (primaryMeeting !== undefined) {
        meeting.Meeting.PrimaryExternalMeetingId = primaryMeeting.Meeting.ExternalMeetingId
      }
    }

    // Store the meeting in the table using the meeting title as the key.
    await putMeeting(query.title, meeting)
  }

  // Create new attendee for the meeting
  console.info('Adding new attendee')
  const attendee = await (client as any).createAttendee({
    // The meeting ID of the created meeting to add the attendee to
    MeetingId: meeting.Meeting.MeetingId,

    // Any user ID you wish to associate with the attendeee.
    // For simplicity here, we use a random UUID for uniqueness
    // combined with the name the user provided, which can later
    // be used to help build the roster.
    ExternalUserId: `${uuidv4().substring(0, 8)}#${query.name}`.substring(0, 64),
  }).promise()

  // Return the meeting and attendee responses. The client will use these
  // to join the meeting.
  let joinResponse: any = {
    JoinInfo: {
      Meeting: meeting,
      Attendee: attendee,
    },
  }
  if (meeting.Meeting.PrimaryExternalMeetingId !== undefined) {
    // Put this where it expects it, since it is not technically part of create meeting response
    joinResponse.JoinInfo.PrimaryExternalMeetingId = meeting.Meeting.PrimaryExternalMeetingId
  }
  return apiResponse(200, 'application/json', JSON.stringify(joinResponse, null, 2))
};

export async function end(event: any, context: any): Promise<Response> {
  // Fetch the meeting by title
  const meeting = await getMeeting(event.queryStringParameters.title)
  const client = getClientForMeeting(meeting)

  // End the meeting. All attendee connections will hang up.
  await client.deleteMeeting({ MeetingId: meeting.Meeting.MeetingId }).promise()
  return apiResponse(200, 'application/json', JSON.stringify({}))
}

export async function deleteAttendee(event: APIGatewayProxyEvent, context: Context): Promise<Response> {
  // Fetch the meeting by title
  if (!event.queryStringParameters || !event.queryStringParameters.title) {
    return apiResponse(400, 'application/json', JSON.stringify({ error: 'Need parameters: title' }))
  }

  const meeting = await getMeeting(event.queryStringParameters.title)
  const client = getClientForMeeting(meeting)

  // End the meeting. All attendee connections will hang up.
  await client.deleteAttendee({
    MeetingId: meeting.Meeting.MeetingId,
    AttendeeId: event.queryStringParameters.attendeeId
  }).promise()

  return apiResponse(200, 'application/json', JSON.stringify({}))
}

export async function logs(event: APIGatewayProxyEvent, context: Context): Promise<Response> {
  return putLogEvents(event, BROWSER_LOG_GROUP_NAME, (logs: LogEvent[], meetingId: string, attendeeId: string) => {
    const logEvents: Log[] = []
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i]
      const timestamp = new Date(log.timestampMs).toISOString()
      const message = `${timestamp} [${log.sequenceNumber}] [${log.logLevel}] [meeting: ${meetingId}] [attendee: ${attendeeId}]: ${log.message}`
      logEvents.push({
        message,
        timestamp: log.timestampMs
      })
    }
    return logEvents
  })
}

export async function logMeetingEvent(event: APIGatewayProxyEvent, context: Context): Promise<Response> {
  return putLogEvents(event, BROWSER_MEETING_EVENT_LOG_GROUP_NAME, (logs: LogEvent[], meetingId: string, attendeeId: string) => {
    const logEvents: Log[] = []
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i]

      // log.message must be a JSON string. CloudWatch Logs Insights will represent
      // nested JSON fields using the dot notation, e.g. attributes.sdkVersion
      logEvents.push({
        message: log.message,
        timestamp: log.timestampMs
      })
      addSignalMetricsToCloudWatch(log.message, meetingId, attendeeId)
    }
    return logEvents
  })
}

export async function logEventIngestion(event: APIGatewayProxyEvent, context: Context): Promise<Response> {
  return putLogEvents(event, BROWSER_EVENT_INGESTION_LOG_GROUP_NAME, (logs: LogEvent[], meetingId: string, attendeeId: string) => {
    const logEvents: Log[] = []
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i]
      const message = `[${log.logLevel}] [meeting: ${meetingId}] [attendee: ${attendeeId}]: ${log.message}`
      logEvents.push({
        message,
        timestamp: log.timestampMs
      })
      addEventIngestionMetricsToCloudWatch(log, meetingId, attendeeId)
    }
    return logEvents
  })
}

// Retrieves capture data for a meeting by title
export async function getCapturePipeline(title: string): Promise<any> {
  const result = await dynamoDb.getItem({
    TableName: MEETINGS_TABLE_NAME,
    Key: {
      Title: {
        S: title
      }
    }
  }).promise()
  return result.Item?.CaptureData ? JSON.parse(result.Item.CaptureData.S as any) : null
}

export async function  addSignalMetricsToCloudWatch(logMsg: string, meetingId: string, attendeeId: string): Promise<void> {
  const logMsgJson = JSON.parse(logMsg)
  const metricList = ['signalingOpenDurationMs', 'iceGatheringDurationMs', 'attendeePresenceDurationMs', 'meetingStartDurationMs']
  const putMetric =
    metricScope(metrics => (metricName: string, metricValue: number, meetingId: string, attendeeId: string) => {
      metrics.setProperty('MeetingId', meetingId)
      metrics.setProperty('AttendeeId', attendeeId)
      metrics.putMetric(metricName, metricValue)
    })

  for (let metricIndex = 0; metricIndex <= metricList.length; metricIndex += 1) {
    const metricName = metricList[metricIndex]
    if (metricName in logMsgJson.attributes) {
      const metricValue = logMsgJson.attributes[metricName]
      console.log('Logging metric -> ', metricName, ': ', metricValue)
      await putMetric(metricName, metricValue, meetingId, attendeeId)
    }
  }
}

export async function addEventIngestionMetricsToCloudWatch(log: LogEvent, meetingId: string, attendeeId: string): Promise<void> {
  const { logLevel, message } = log

  const putMetric =
    metricScope(metrics => (metricName: string, metricValue: number, meetingId: string, attendeeId: string) => {
      metrics.setProperty('MeetingId', meetingId)
      metrics.setProperty('AttendeeId', attendeeId)
      metrics.putMetric(metricName, metricValue)
    })

  let errorMetricValue = 0
  let retryMetricValue = 0
  let ingestionTriggerSuccessMetricValue = 0
  let networkErrors = 0

  if (logLevel === 'WARN' && message.includes('Retry count limit reached')) {
    retryMetricValue = 1
  } else if (logLevel === 'ERROR') {
    errorMetricValue = 1
  } else if (message.includes('send successful')) {
    ingestionTriggerSuccessMetricValue = 1
  } else if (message.match(/(NetworkError|AbortError|Failed to fetch)/g) !== null) {
    networkErrors = 1
  }
  await putMetric('EventIngestionTriggerSuccess', ingestionTriggerSuccessMetricValue, meetingId, attendeeId)
  await putMetric('EventIngestionError', errorMetricValue, meetingId, attendeeId)
  await putMetric('EventIngestionRetryCountLimitReached', retryMetricValue, meetingId, attendeeId)
  await putMetric('EventIngestionNetworkErrors', networkErrors, meetingId, attendeeId)
}

 // Creates log stream if necessary and returns the current sequence token
export async function ensureLogStream(logGroupName: string, logStreamName: string): Promise<any> {
  const logStreamsResult = await cloudWatchClient.describeLogStreams({
    logGroupName: logGroupName,
    logStreamNamePrefix: logStreamName,
  }).promise();
  
  const foundStream = logStreamsResult?.logStreams?.find(logStream => logStream.logStreamName === logStreamName);
  
  if (foundStream) {
    return foundStream.uploadSequenceToken;
  }
  await cloudWatchClient.createLogStream({
    logGroupName: logGroupName,
    logStreamName: logStreamName,
  }).promise();
  return null;
}

export async function putLogEvents(event: APIGatewayProxyEvent, logGroupName: string, createLogEvents: any): Promise<Response> {
  const body = JSON.parse(event.body || '{}')

  if (!body.logs || !body.meetingId || !body.attendeeId || !body.appName) {
    return apiResponse(400, 'application/json', JSON.stringify({
      error: 'Required properties: logs, meetingId, attendeeId, appName'
    }))
  } else if (!body.logs.length) {
    return apiResponse(200, 'application/json', JSON.stringify({}))
  }

  const putLogEventsInput: any = {
    logGroupName,
    logStreamName: createLogStreamName(body.meetingId, body.attendeeId),
    logEvents: createLogEvents(body.logs, body.meetingId, body.attendeeId)
  }

  const uploadSequenceToken = await ensureLogStream(logGroupName, putLogEventsInput.logStreamName)
  if (uploadSequenceToken) {
    putLogEventsInput.sequenceToken = uploadSequenceToken
  }

  try {
    await cloudWatchClient.putLogEvents(putLogEventsInput).promise()
  } catch (error) {
    const errorMessage = `Failed to put CloudWatch log events with error ${error} and params ${JSON.stringify(putLogEventsInput)}`
    if (error.code === 'InvalidSequenceTokenException' || error.code === 'DataAlreadyAcceptedException') {
      console.warn(errorMessage)
    } else {
      console.error(errorMessage)
    }
  }
  return apiResponse(200, 'application/json', JSON.stringify({}))
}

// Called when SQS receives records of meeting events and logs out those records
export async function sqs(event: SQSEvent, context: Context, callback: APIGatewayProxyCallback): Promise<any> {
  console.log(event.Records)
  return {}
}

export async function eventBridge(event: any, context: any) {
  console.log(event);
  return {};
}

export async function checkSqs(event: any, context: any) {
  console.log(process.env.sqsArn)
  console.log(process.env.teste)
  return {}
}