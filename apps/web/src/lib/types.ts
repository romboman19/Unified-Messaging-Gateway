export type ChannelType = 'sms' | 'whatsapp' | 'signal' | 'mock';
export type MessageDirection = 'inbound' | 'outbound';

export type MessageStatus =
  | 'created'
  | 'scheduled'
  | 'queued'
  | 'dispatching'
  | 'accepted'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'unknown';

export interface MessageAttempt {
  id: string;
  attemptNo: number;
  startedAt: string;
  finishedAt: string | null;
  result: string;
  errorJson: unknown;
}

export interface StatusHistoryEntry {
  id: string;
  status: MessageStatus;
  source: string;
  payload: unknown;
  createdAt: string;
}

export interface Message {
  id: string;
  externalId: string | null;
  channelType: ChannelType;
  direction: MessageDirection;
  messageType: string;
  status: MessageStatus;
  toJson: { e164?: string; raw?: string } | null;
  contentJson: { text?: string } | null;
  createdAt: string;
  updatedAt: string;
  attempts?: MessageAttempt[];
  statusHistory?: StatusHistoryEntry[];
  attemptsCount?: number;
  statusHistoryCount?: number;
}

export interface Conversation {
  id: string;
  channelType: ChannelType;
  endpointId: string;
  peerId: string | null;
  peerPhoneE164: string | null;
  lastMessageAt: string | null;
  endpoint: { id: string; label: string } | null;
  endpointLabel: string | null;
  lastMessage: {
    id: string;
    direction: MessageDirection;
    messageType: string;
    status: MessageStatus;
    preview: string;
    createdAt: string;
  } | null;
}

export interface Endpoint {
  id: string;
  label: string;
  externalId: string | null;
  phoneE164: string | null;
  enabled: boolean;
}

export interface TransportAccount {
  id: string;
  name: string;
  type: ChannelType;
  adapter: string;
  status: string;
  endpoints: Endpoint[];
}

export type DestinationType = 'webhook' | 'email' | 'telegram' | 'internal_log';

export interface Destination {
  id: string;
  name: string;
  type: DestinationType;
  enabled: boolean;
  url: string | null;
  hasSecret: boolean;
  configJson: Record<string, unknown>;
  fieldSelector: string[];
  templateJson: Record<string, unknown> | null;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  eventTypes: string[];
  filters: {
    channelType?: ChannelType;
    accountId?: string;
    endpointId?: string;
    direction?: MessageDirection;
    severity?: string;
  };
  fieldSelector: string[];
  destinations: { id: string; name: string; type: DestinationType; enabled: boolean }[];
  createdAt: string;
  updatedAt: string;
}

export type DeliveryStatus = 'pending' | 'delivering' | 'delivered' | 'failed' | 'dlq';

export interface Delivery {
  id: string;
  eventId: string;
  destinationId: string;
  status: DeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastResponseCode: number | null;
  lastError: string | null;
  requestJson: unknown;
  responseJson: unknown;
  durationMs: number | null;
  createdAt: string;
  destination?: { id: string; name: string; type: DestinationType };
  event?: { id: string; eventType: string; createdAt: string };
}

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Alert {
  id: string;
  fingerprint: string;
  ruleKey: string;
  severity: AlertSeverity;
  status: 'firing' | 'resolved';
  title: string;
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export interface AlertRule {
  key: string;
  name: string;
  enabled: boolean;
  configJson: Record<string, unknown>;
}

export interface ApiToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AuditLog {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  actor: { id: string; username: string } | null;
}

export interface MessageEvent {
  id: string;
  eventType: string;
  aggregateId: string | null;
  channelType: ChannelType | null;
  accountId: string | null;
  endpointId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface ListResponse<T> {
  items: T[];
  count: number;
}
