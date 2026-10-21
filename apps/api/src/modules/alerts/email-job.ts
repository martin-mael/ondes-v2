import { defineJob, jobType } from '@ondes/queue';
import { alertSeveritySchema } from '@ondes/shared';
import { z } from 'zod';
import type { AlertService } from './service.ts';

/**
 * The `alert-email` job: email an alert's managers, once per (alert, severity). On the
 * `notify` lane, which the api consumes itself (the worker never does). Retries come from the
 * queue framework; the per-recipient notification log makes a retry skip who already got it.
 */
export const alertEmailJobSchema = z.object({
  alertId: z.uuid(),
  severity: alertSeveritySchema,
  /** Escalated to this severity (rather than raised at it). */
  escalated: z.boolean(),
});

const options = {
  lane: 'notify' as const,
  idempotencyKey: (p: z.output<typeof alertEmailJobSchema>) =>
    `alert-email:${p.alertId}:${p.severity}`,
};

/** For publishers (`app.rabbit.jobs.enqueue`). */
export const alertEmailJobType = jobType('alert-email', alertEmailJobSchema, options);

/** The consumer, bound to the alert service. */
export const alertEmailJob = (alerts: AlertService) =>
  defineJob('alert-email', alertEmailJobSchema, (payload) => alerts.sendEmail(payload), options);
