import type { ReportChange } from '../lib/reporting';

export type ChangeNotification = {
  runId: string;
  monitorId: string;
  monitorName: string;
  date: string;
  changes: ReportChange[];
};

/** Implement this contract for email, an API, a Mastra Channel, or another destination. */
export interface NotificationProvider {
  id: string;
  notify(event: ChangeNotification): Promise<void>;
}
