import { Connection } from 'rabbitmq-client';
import {
  createTopology,
  declareTopology,
  type Topology,
  type TopologyOptions,
} from './topology.ts';

export type QueueConnection = {
  rabbit: Connection;
  topology: Topology;
  close(): Promise<void>;
};

/**
 * Opens a connection (it reconnects on its own) and declares the whole topology, so the api
 * and the worker can start in any order.
 */
export async function connectQueue(
  url: string,
  options: TopologyOptions & { connectionName?: string } = {},
): Promise<QueueConnection> {
  const rabbit = new Connection({ url, connectionName: options.connectionName });
  const topology = createTopology(options);
  try {
    await rabbit.onConnect(10_000);
    await declareTopology(rabbit, topology);
  } catch (error) {
    rabbit.unsafeDestroy();
    throw error;
  }
  return { rabbit, topology, close: () => rabbit.close() };
}
