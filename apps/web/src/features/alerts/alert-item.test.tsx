import type { Alert } from '@ondes/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../app/i18n/i18n.tsx';
import { AlertItem } from './alert-item.tsx';

// The alerts in French (#71): texts from `details.i18n`, type labels, station-time instants.

const at = new Date('2026-10-23T12:05:00.000Z');

function alert(over: Partial<Alert>): Alert {
  return {
    id: '01a169cc-0000-7000-8000-000000000001',
    orgId: '01a15ddf-0000-7000-8000-0000000000a1',
    stationId: '01a15ddf-0000-7000-8000-0000000000b1',
    type: 'engine.silence',
    severity: 'warning',
    status: 'open',
    dedupeKey: 'k',
    title: 'English title',
    message: 'English message',
    details: {},
    occurrences: 1,
    raisedAt: at,
    lastSeenAt: at,
    escalatedAt: null,
    escalateAt: null,
    escalateTo: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolution: null,
    action: null,
    ...over,
  };
}

function renderFr(a: Alert) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider locale="fr">
        <ul>
          <AlertItem alert={a} stationId={a.stationId} timeZone="Europe/Paris" canManage />
        </ul>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return screen.getByTestId('alert-item');
}

describe('alerts in French', () => {
  it('renders a failed render, with its air time on the station’s clock', () => {
    const item = renderFr(
      alert({
        type: 'island.render_failed',
        details: {
          i18n: {
            key: 'islandRenderFailed',
            params: { error: 'source manquante', airsAt: '2026-10-23T18:30:00.000Z' },
          },
        },
      }),
    );
    expect(item).toHaveTextContent('Rendu en échec');
    expect(item).toHaveTextContent(
      'Une transition avec voix n’a pas pu être rendue (source manquante). Elle passera 20:30 en simple fondu enchaîné, la voix par-dessus.',
    );
    expect(item).toHaveTextContent('Levée 14:05');
    expect(item).toHaveTextContent('Prendre en charge');
  });

  it('renders engine restarts and missing episodes', () => {
    const restart = renderFr(
      alert({
        type: 'engine.restarted',
        occurrences: 2,
        details: { i18n: { key: 'engineRestarted', params: { restarts: 2, minutes: 10 } } },
      }),
    );
    expect(restart).toHaveTextContent('Redémarrages du moteur');
    expect(restart).toHaveTextContent(
      'Le moteur de la station a planté et redémarré (2 redémarrages ces 10 dernières min).',
    );
    expect(restart).toHaveTextContent('2 fois');
  });

  it('falls back to the type’s French label and the producer’s message', () => {
    const item = renderFr(alert({ type: 'stream.source_missing', message: 'No source on /x' }));
    expect(item).toHaveTextContent('Flux sans source');
    expect(item).toHaveTextContent('No source on /x');
    expect(item).toHaveTextContent('Attention');
  });
});
