import type { Permission } from '@ondes/shared';
import type { ComponentType } from 'react';
import { LiveNowPlayingControl } from '../live/live-now-playing.tsx';
import { LiveRequestPrompt } from '../live/live-requests.tsx';
import {
  AlertsPanel,
  EngineStatusPanel,
  ListenersPanel,
  LiveSourcesPanel,
} from './health/index.ts';
import { OnAirWidget } from './on-air/on-air-widget.tsx';

// The station dashboard's widgets (#69), top to bottom. Each one is a self-contained component
// that reads its own data (the api through `app/api/client.ts`, real time through `useSse`) and
// renders nothing when it has nothing to show. One entry per feature: add yours here.

export interface DashboardWidget {
  id: string;
  Component: ComponentType<{ stationId: string }>;
  /** Hidden from roles without it. The api checks permissions regardless. */
  permission?: Permission;
  /** `full` spans the page; `half` sits beside the next `half` on wide screens. */
  width: 'full' | 'half';
}

export const dashboardWidgets: DashboardWidget[] = [
  // Ad-hoc live requests (#65): "DJ X is connected, put on air?", for those who can decide.
  {
    id: 'live-requests',
    Component: LiveRequestPrompt,
    permission: 'engine:control',
    width: 'full',
  },
  // On air (#70): clock, mode, current and next items, next hard event, show block.
  { id: 'on-air', Component: OnAirWidget, permission: 'dashboard:read', width: 'full' },
  // Live metadata (#68): while a DJ is on air, what the streams show, and a manual override.
  {
    id: 'live-now-playing',
    Component: LiveNowPlayingControl,
    permission: 'engine:control',
    width: 'full',
  },
  // Health, listeners and alerts (#71).
  { id: 'engine-status', Component: EngineStatusPanel, permission: 'engine:read', width: 'half' },
  { id: 'live-sources', Component: LiveSourcesPanel, permission: 'engine:read', width: 'half' },
  { id: 'listeners', Component: ListenersPanel, permission: 'dashboard:read', width: 'half' },
  { id: 'alerts', Component: AlertsPanel, permission: 'alert:read', width: 'half' },
];
