import LidarrAPI from '@server/api/servarr/lidarr';
import RadarrAPI from '@server/api/servarr/radarr';
import ReadarrAPI from '@server/api/servarr/readarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { getRepository } from '@server/datasource';
import type { DownloadRecoveryServiceType } from '@server/entity/DownloadRecoveryState';
import QueueIntervention from '@server/entity/QueueIntervention';
import { runWithServarrServiceSnapshot } from '@server/lib/serviceAdmission';
import { getSettings, type DVRSettings } from '@server/lib/settings';
import {
  BoundedTaskQueue,
  mapWithConcurrency,
} from '@server/utils/concurrency';
import { In, LessThan } from 'typeorm';
import { InterventionError } from './errors';
import {
  isActionableQueueItem,
  queueIdentity,
  safeDiagnostic,
  serviceAuthority,
  warningText,
  type InterventionQueueItem,
} from './identity';
import {
  candidateFingerprint,
  importCandidates,
  selectImportFiles,
} from './manualImport';

const work = new BoundedTaskQueue(3, 32);
const lastRefresh = new Map<string, number>();
const flights = new Map<string, Promise<void>>();
export { InterventionError } from './errors';
export function interventionSources() {
  const settings = getSettings();
  return (['radarr', 'sonarr', 'lidarr', 'readarr'] as const).flatMap((type) =>
    settings[type]
      .filter((server) => server.syncEnabled)
      .map((server) => ({ type, server }))
  );
}
function client(type: DownloadRecoveryServiceType, server: DVRSettings) {
  const Api = {
    radarr: RadarrAPI,
    sonarr: SonarrAPI,
    lidarr: LidarrAPI,
    readarr: ReadarrAPI,
  }[type];
  return new Api({
    url: Api.buildUrl(
      server,
      type === 'radarr' || type === 'sonarr' ? '/api/v3' : '/api/v1'
    ),
    apiKey: server.apiKey,
  });
}
type ActionRecord = {
  at: string;
  actorId: number;
  action: 'import' | 'reject';
  state: string;
  options: {
    importMode?: string;
    fileCount?: number;
    blocklist?: boolean;
    removeFromClient?: boolean;
  };
};
const actionRecords = (row: QueueIntervention): ActionRecord[] =>
  JSON.parse(row.actions || '[]');
function recordIntent(
  row: QueueIntervention,
  action: ActionRecord['action'],
  options: ActionRecord['options']
) {
  const actions = actionRecords(row);
  actions.push({
    at: row.actionAt!.toISOString(),
    actorId: row.actorId!,
    action,
    state: row.state,
    options,
  });
  row.actions = JSON.stringify(actions.slice(-50));
}
function recordOutcome(row: QueueIntervention) {
  const actions = actionRecords(row);
  if (actions.length)
    actions[actions.length - 1].state = row.resolution || row.state;
  row.actions = JSON.stringify(actions);
}
export function projectIntervention(item: QueueIntervention) {
  return {
    id: item.id,
    serviceType: item.serviceType,
    serviceId: item.serviceId,
    serviceName: item.serviceName,
    title: item.title,
    warnings: JSON.parse(item.warnings) as string[],
    actions: actionRecords(item),
    state: item.state,
    resolution: item.resolution,
    actorId: item.actorId,
    manualImportCapable:
      item.serviceType === 'radarr' || item.serviceType === 'sonarr',
    createdAt: item.createdAt,
    lastSeenAt: item.lastSeenAt,
    actionAt: item.actionAt,
    resolvedAt: item.resolvedAt,
  };
}
/** Called under service admission, so queue identity and configuration cannot change mid-action. */
async function reconcile(
  type: DownloadRecoveryServiceType,
  server: DVRSettings,
  items: InterventionQueueItem[],
  complete = true
) {
  const repo = getRepository(QueueIntervention);
  const authority = serviceAuthority(type, server);
  const existing = await repo
    .createQueryBuilder('warning')
    .addSelect('warning.downloadId')
    .where(
      "warning.serviceType = :type AND warning.serviceId = :id AND warning.state != 'resolved'",
      {
        type,
        id: server.id,
      }
    )
    .take(5001)
    .getMany();
  if (existing.length > 5000)
    throw new InterventionError(
      409,
      'The inbox reached its active warning limit.'
    );
  const identities = new Map(
    items.map((item) => [queueIdentity(authority, item), item])
  );
  for (const row of existing.filter((row) => row.state !== 'resolved')) {
    const current = identities.get(row.identity);
    if (row.authority !== authority) {
      row.state = 'resolved';
      row.resolution = 'configuration-changed';
      row.resolvedAt = new Date();
    } else if (row.state === 'importing') {
      if (row.commandId) {
        try {
          const command = await work.run(() =>
            client(type, server).getCommand(row.commandId!)
          );
          if (
            command.status === 'failed' ||
            command.result === 'unsuccessful'
          ) {
            row.state = 'failed';
            row.resolution = 'import-failed';
          } else if (command.status === 'completed') {
            // A completed command can skip individual files. Require a matching import event.
            const history = await work.run(() =>
              client(type, server).getHistory(1000)
            );
            const imported = history.some(
              (event) =>
                row.downloadId &&
                event.downloadId === row.downloadId &&
                /downloadfolderimported|downloadimported/i.test(
                  String(event.eventType)
                ) &&
                event.date &&
                row.actionAt &&
                new Date(event.date).getTime() >= row.actionAt.getTime() - 1000
            );
            if (
              !imported &&
              row.actionAt &&
              Date.now() - row.actionAt.getTime() < 120000
            )
              continue;
            row.state = imported ? 'resolved' : 'failed';
            row.resolution = imported ? 'manual-import' : 'import-needs-review';
            if (imported) row.resolvedAt = new Date();
          }
        } catch {
          // Commands can be pruned by the backend. Preserve uncertainty rather than staying pending forever.
          if (row.actionAt && Date.now() - row.actionAt.getTime() > 86400000) {
            row.state = 'failed';
            row.resolution = 'import-outcome-unknown';
          }
        }
      } else {
        row.state = 'failed';
        row.resolution = 'import-outcome-unknown';
      }
    } else if (!current && complete) {
      row.resolution =
        row.state === 'rejecting' ? 'manual-rejection' : 'no-longer-in-queue';
      row.state = 'resolved';
      row.resolvedAt = new Date();
    } else if (row.state === 'rejecting') {
      // Do not repeat a possibly applied remote operation after a crash.
      row.state = 'failed';
      row.resolution = 'rejection-outcome-unknown';
    } else if (current && !isActionableQueueItem(current)) {
      row.state = 'resolved';
      row.resolution = 'recovered';
      row.resolvedAt = new Date();
    }
    if (current) {
      row.lastSeenAt = new Date();
      row.warnings = warningText(current, server.apiKey);
    }
    recordOutcome(row);
    await repo.save(row);
  }
  const warningItems = items.filter(isActionableQueueItem).slice(0, 5000);
  const known = new Map(existing.map((row) => [row.identity, row]));
  const missing = warningItems
    .map((item) => queueIdentity(authority, item))
    .filter((identity) => !known.has(identity));
  for (let offset = 0; offset < missing.length; offset += 200) {
    const rows = await repo.findBy({
      identity: In(missing.slice(offset, offset + 200)),
    });
    rows.forEach((row) => known.set(row.identity, row));
  }
  let activeCount = existing.filter((row) => row.state !== 'resolved').length;
  const updates: QueueIntervention[] = [];
  for (const item of warningItems) {
    const identity = queueIdentity(authority, item);
    const old = known.get(identity);
    if (old) {
      if (
        old.state === 'resolved' &&
        ['recovered', 'no-longer-in-queue'].includes(old.resolution ?? '')
      ) {
        if (activeCount >= 5000)
          throw new InterventionError(
            409,
            'The inbox reached its active warning limit.'
          );
        old.state = 'active';
        old.resolution = null;
        old.resolvedAt = null;
        old.lastSeenAt = new Date();
        old.warnings = warningText(item, server.apiKey);
        updates.push(old);
        activeCount++;
      }
      continue;
    }
    if (activeCount >= 5000)
      throw new InterventionError(
        409,
        'The inbox reached its active warning limit.'
      );
    updates.push(
      repo.create({
        identity,
        authority,
        serviceType: type,
        serviceId: server.id,
        serviceName: safeDiagnostic(server.name, server.apiKey).slice(0, 200),
        queueId: item.id,
        downloadId:
          typeof item.downloadId === 'string'
            ? item.downloadId.slice(0, 1000)
            : null,
        title: safeDiagnostic(item.title, server.apiKey).slice(0, 1000),
        warnings: warningText(item, server.apiKey),
        state: 'active',
        actions: '[]',
        createdAt: new Date(),
        lastSeenAt: new Date(),
      })
    );
    activeCount++;
  }
  if (updates.length) await repo.save(updates, { chunk: 200 });
  const overflow = await repo.find({
    where: { state: 'resolved', serviceType: type, serviceId: server.id },
    order: { resolvedAt: 'DESC' },
    skip: 2000,
    take: 5000,
    select: { id: true },
  });
  for (let offset = 0; offset < overflow.length; offset += 200)
    await repo.delete({
      id: In(overflow.slice(offset, offset + 200).map((row) => row.id)),
    });
  await repo.delete({
    state: 'resolved',
    resolvedAt: LessThan(new Date(Date.now() - 90 * 86400000)),
  });
}
export async function observeInterventionQueue(
  type: DownloadRecoveryServiceType,
  server: DVRSettings,
  items: InterventionQueueItem[]
) {
  const source = interventionSources().find(
    (source) => source.type === type && source.server.id === server.id
  );
  if (
    !source ||
    serviceAuthority(type, source.server) !== serviceAuthority(type, server)
  )
    return;
  await runWithServarrServiceSnapshot(type, source.server, (current) =>
    reconcile(type, current, items, false)
  );
}
export async function refreshInterventions() {
  const sources = interventionSources();
  const partialSources: { serviceType: string; serviceId: number }[] = [];
  await mapWithConcurrency(
    sources.slice(0, 20),
    3,
    async ({ type, server }) => {
      const key = serviceAuthority(type, server);
      if (Date.now() - (lastRefresh.get(key) ?? 0) < 30000) return;
      try {
        let flight = flights.get(key);
        if (!flight) {
          flight = runWithServarrServiceSnapshot(
            type,
            server,
            async (current) => {
              const items = await work.run<InterventionQueueItem[]>(() =>
                client(type, current).getInterventionQueue()
              );
              await reconcile(type, current, items);
              lastRefresh.set(key, Date.now());
              if (lastRefresh.size > 100)
                lastRefresh.delete(lastRefresh.keys().next().value!);
            }
          ).finally(() => flights.delete(key));
          flights.set(key, flight);
        }
        await flight;
      } catch {
        partialSources.push({ serviceType: type, serviceId: server.id });
      }
    }
  );
  return { partialSources, truncated: sources.length > 20 };
}
async function admitted<T>(
  id: number,
  operation: (
    row: QueueIntervention,
    api: ReturnType<typeof client>,
    item: InterventionQueueItem,
    server: DVRSettings
  ) => Promise<T>
) {
  const repo = getRepository(QueueIntervention);
  const snapshot = await repo.findOneBy({ id });
  if (!snapshot)
    throw new InterventionError(404, 'Download warning not found.');
  const source = interventionSources().find(
    ({ type, server }) =>
      type === snapshot.serviceType && server.id === snapshot.serviceId
  );
  if (
    !source ||
    serviceAuthority(source.type, source.server) !== snapshot.authority
  )
    throw new InterventionError(
      409,
      'The acquisition service configuration changed. Refresh the inbox.'
    );
  return runWithServarrServiceSnapshot(
    source.type,
    source.server,
    async (server) => {
      const row = await repo.findOneByOrFail({ id });
      if (!['active', 'failed'].includes(row.state))
        throw new InterventionError(
          409,
          'This warning already has an action in progress or is resolved.'
        );
      const api = client(source.type, server);
      const items = await work.run<InterventionQueueItem[]>(() =>
        api.getInterventionQueue()
      );
      const item = items.find(
        (item) => queueIdentity(row.authority, item) === row.identity
      );
      if (!item)
        throw new InterventionError(
          409,
          'The download changed or left the queue. Refresh before acting.'
        );
      return operation(row, api, item, server);
    }
  );
}
export const previewIntervention = (id: number) =>
  admitted(id, async (row, api, item, server) => {
    const candidates = await importCandidates(row.serviceType, api, item);
    return {
      fingerprint: candidateFingerprint(candidates),
      candidates: candidates.map((candidate) => ({
        id: candidate.id,
        name: safeDiagnostic(candidate.name, server.apiKey),
        size: candidate.size,
        rejections: candidate.rejections.map((reason) =>
          safeDiagnostic(reason, server.apiKey)
        ),
        eligible: candidate.eligible,
      })),
    };
  });
export const rejectIntervention = (
  id: number,
  actorId: number,
  blocklist: boolean,
  removeFromClient: boolean
) =>
  admitted(id, async (row, api, item) => {
    const repo = getRepository(QueueIntervention);
    row.state = 'rejecting';
    row.actorId = actorId;
    row.actionAt = new Date();
    row.resolution = null;
    recordIntent(row, 'reject', { blocklist, removeFromClient });
    await repo.save(row);
    try {
      await work.run(() =>
        api.deleteQueueItem(item.id, {
          blocklist,
          removeFromClient,
          skipRedownload: false,
        })
      );
      row.state = 'resolved';
      row.resolution = blocklist ? 'manual-blocklist' : 'manual-rejection';
      row.resolvedAt = new Date();
    } catch {
      row.state = 'failed';
      row.resolution = 'rejection-outcome-unknown';
    }
    recordOutcome(row);
    await repo.save(row);
    return projectIntervention(row);
  });
export const importIntervention = (
  id: number,
  actorId: number,
  selection: number[],
  mode: 'copy' | 'move',
  fingerprint: string
) =>
  admitted(id, async (row, api, item) => {
    const candidates = await importCandidates(row.serviceType, api, item);
    if (candidateFingerprint(candidates) !== fingerprint)
      throw new InterventionError(
        409,
        'The import preview changed. Preview files again before importing.'
      );
    const files = selectImportFiles(candidates, selection);
    const repo = getRepository(QueueIntervention);
    row.state = 'importing';
    row.actorId = actorId;
    row.actionAt = new Date();
    row.commandId = null;
    row.resolution = null;
    recordIntent(row, 'import', {
      importMode: mode,
      fileCount: selection.length,
    });
    await repo.save(row);
    try {
      const command = await work.run(() => api.importManualFiles(files, mode));
      row.commandId = command.id;
    } catch {
      row.state = 'failed';
      row.resolution = 'import-outcome-unknown';
    }
    recordOutcome(row);
    await repo.save(row);
    return projectIntervention(row);
  });
