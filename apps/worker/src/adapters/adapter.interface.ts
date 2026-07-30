export interface SendResult {
  externalId?: string;
  status: 'accepted' | 'sent' | 'delivered' | 'failed' | 'unknown';
  raw: unknown;
}

export interface TransportAdapter {
  send(message: unknown): Promise<SendResult>;
}
