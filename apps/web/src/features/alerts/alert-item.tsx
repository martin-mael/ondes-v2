import type { Alert, AlertSeverity } from '@ondes/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, HandIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { isApiError } from '../../app/api/client.ts';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { DelayedSpinner } from '../../app/pending.tsx';
import { alertsApi, invalidateAlerts } from './api.ts';
import { alertText, alertTypeLabel, formatStationTime } from './format.ts';
import { useAlertT } from './messages.ts';

// One alert, for the alerts page and the dashboard's alerts panel: a severity strip, the text in
// the viewer's language, its times on the station's clock, and acknowledge / resolve for
// members with `alert:manage`.

export const severityTone: Record<AlertSeverity, string> = {
  critical: 'bg-destructive',
  warning: 'bg-amber-500',
  info: 'bg-sky-500',
};

export function AlertItem({
  alert,
  stationId,
  timeZone,
  canManage,
  compact = false,
}: {
  alert: Alert;
  stationId: string;
  timeZone: string;
  canManage: boolean;
  /** The dashboard's panel: no resolve, shorter meta. */
  compact?: boolean;
}) {
  const t = useAlertT();
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const text = alertText(alert, t, timeZone, locale);
  const time = (d: Date) => formatStationTime(d, timeZone, locale);
  const onError = (error: unknown) =>
    toast.error(isApiError(error, 'alert_resolved') ? t('error.alert_resolved') : String(error));
  const acknowledge = useMutation({
    mutationFn: () => alertsApi.acknowledge(stationId, alert.id),
    onSuccess: () => toast.success(t('acknowledgedToast')),
    onError,
    onSettled: () => invalidateAlerts(queryClient, stationId),
  });
  const resolve = useMutation({
    mutationFn: () => alertsApi.resolve(stationId, alert.id),
    onSuccess: () => toast.success(t('resolvedToast')),
    onError,
    onSettled: () => invalidateAlerts(queryClient, stationId),
  });
  const open = alert.status === 'open';

  return (
    <li
      className="relative flex flex-col gap-1 overflow-hidden rounded-[4px] bg-muted/40 py-2 pr-3 pl-4 text-sm sm:flex-row sm:items-start sm:gap-3"
      data-testid="alert-item"
      data-severity={alert.severity}
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-1 ${open ? severityTone[alert.severity] : 'bg-muted-foreground/30'}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{text.title}</span>
          <Badge variant={alert.severity === 'critical' && open ? 'destructive' : 'outline'}>
            {t(`severity.${alert.severity}`)}
          </Badge>
          {!compact && alertTypeLabel(alert.type, t) !== text.title && (
            <span className="text-xs text-muted-foreground">{alertTypeLabel(alert.type, t)}</span>
          )}
          {alert.occurrences > 1 && (
            <span className="text-xs text-muted-foreground">
              {t('occurrences', { count: alert.occurrences })}
            </span>
          )}
        </div>
        {text.message && <p className="text-muted-foreground">{text.message}</p>}
        <p className="text-xs text-muted-foreground tabular-nums">
          {t('raisedAt', { time: time(alert.raisedAt) })}
          {!compact && open && alert.occurrences > 1 && (
            <> · {t('lastSeenAt', { time: time(alert.lastSeenAt) })}</>
          )}
          {alert.acknowledgedAt && (
            <> · {t('acknowledgedAt', { time: time(alert.acknowledgedAt) })}</>
          )}
          {alert.resolvedAt && <> · {t('resolvedAt', { time: time(alert.resolvedAt) })}</>}
        </p>
      </div>
      {open && (
        <div className="flex shrink-0 items-center gap-2">
          {alert.acknowledgedAt ? (
            <Badge variant="secondary">
              <CheckIcon />
              {t('acknowledged')}
            </Badge>
          ) : (
            canManage && (
              <Button
                size="sm"
                variant="outline"
                disabled={acknowledge.isPending}
                onClick={() => acknowledge.mutate()}
              >
                <DelayedSpinner when={acknowledge.isPending} />
                {!acknowledge.isPending && <HandIcon />}
                {t('acknowledge')}
              </Button>
            )
          )}
          {canManage && !compact && (
            <Button
              size="sm"
              variant="ghost"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate()}
            >
              <DelayedSpinner when={resolve.isPending} />
              {t('resolve')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
