import { Injectable, Logger } from '@nestjs/common';

/**
 * SMS alerts via Africa's Talking (course Week 5 third-party integration).
 * Without AT_USERNAME/AT_API_KEY the service degrades to log-only so every
 * environment (CI, teammates without keys) still works end-to-end.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  get configured(): boolean {
    return Boolean(process.env.AT_USERNAME && process.env.AT_API_KEY);
  }

  async send(to: string, message: string): Promise<{ delivered: boolean; detail: string }> {
    if (!this.configured) {
      this.logger.log(`[SMS log-only] to=${to}: ${message}`);
      return { delivered: false, detail: 'log-only (no Africa’s Talking credentials)' };
    }
    try {
      const res = await fetch('https://api.africastalking.com/version1/messaging', {
        method: 'POST',
        headers: {
          apiKey: process.env.AT_API_KEY!,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          username: process.env.AT_USERNAME!,
          to,
          message,
          ...(process.env.AT_SENDER ? { from: process.env.AT_SENDER } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      const ok = res.ok;
      if (!ok) this.logger.error({ status: res.status, body }, 'SMS send failed');
      return { delivered: ok, detail: ok ? 'sent' : `HTTP ${res.status}` };
    } catch (err) {
      this.logger.error({ err }, 'SMS send error');
      return { delivered: false, detail: 'network error' };
    }
  }
}
