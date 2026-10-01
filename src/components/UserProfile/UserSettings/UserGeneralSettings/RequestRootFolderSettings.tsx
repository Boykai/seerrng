import defineMessages from '@app/utils/defineMessages';
import type {
  ComicServiceOption,
  ServiceCommonServer,
  ServiceCommonServerWithDetails,
} from '@server/interfaces/api/serviceInterfaces';
import type { UserRequestRootFolders } from '@server/interfaces/api/userSettingsInterfaces';
import axios from 'axios';
import { useMemo } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

type ArrServiceType = 'radarr' | 'sonarr' | 'lidarr' | 'readarr';
type RequestRootFolderServiceType = ArrServiceType | 'comic-kapowarr';
type RequestRootFolderMediaType =
  'movie' | 'series' | 'music' | 'books' | 'audiobooks' | 'comics';

interface RequestRootFolderGroup {
  key: string;
  serviceType: RequestRootFolderServiceType;
  mediaType: RequestRootFolderMediaType;
  name: string;
  paths: string[];
  unavailable: boolean;
}

interface RequestRootFolderOptions {
  groups: RequestRootFolderGroup[];
  incomplete: boolean;
}

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserGeneralSettings.RequestRootFolders',
  {
    title: 'Default Request Folders',
    description:
      'Requests made for this user will use the selected folder on that service. Unset folders keep the service default. If a saved folder is no longer available, requests use the service default.',
    movie: 'Movies',
    series: 'Series',
    music: 'Music',
    books: 'Books',
    audiobooks: 'Audiobooks',
    comics: 'Comics',
    service: '{mediaType} · {name}',
    useServiceDefault: 'Use service default',
    loading: 'Loading folders…',
    unavailable: 'Could not load folders from one or more services.',
    savedUnavailable: 'Saved folder (not currently offered by this service)',
    noFolderOptions: 'No folders are available from this service.',
  }
);

const requestServices: ArrServiceType[] = [
  'radarr',
  'sonarr',
  'lidarr',
  'readarr',
];

const getArrMediaType = (
  serviceType: ArrServiceType,
  configuredType?: string
): RequestRootFolderMediaType => {
  switch (serviceType) {
    case 'radarr':
      return 'movie';
    case 'sonarr':
      return 'series';
    case 'lidarr':
      return 'music';
    case 'readarr':
      return configuredType === 'audiobook' ? 'audiobooks' : 'books';
  }
};

const loadRequestRootFolderOptions =
  async (): Promise<RequestRootFolderOptions> => {
    const services = await Promise.allSettled(
      requestServices.map(async (serviceType) => {
        const { data } = await axios.get<ServiceCommonServer[]>(
          `/api/v1/service/${serviceType}`
        );
        return { serviceType, servers: data };
      })
    );
    const serverGroups = services.flatMap((result) =>
      result.status === 'fulfilled'
        ? result.value.servers.map((server) => ({
            serviceType: result.value.serviceType,
            server,
          }))
        : []
    );
    const groups: RequestRootFolderGroup[] = [];
    let incomplete = services.some((result) => result.status === 'rejected');

    for (let index = 0; index < serverGroups.length; index += 5) {
      const batch = serverGroups.slice(index, index + 5);
      const details = await Promise.allSettled(
        batch.map(async ({ serviceType, server }) => {
          const { data } = await axios.get<ServiceCommonServerWithDetails>(
            `/api/v1/service/${serviceType}/${server.id}`
          );
          return {
            key: `${serviceType}:${server.id}`,
            serviceType,
            mediaType: getArrMediaType(serviceType, server.serviceType),
            name: server.name,
            paths: data.rootFolders
              .map((folder) => folder.path)
              .filter((folderPath): folderPath is string => !!folderPath),
          };
        })
      );
      for (
        let detailIndex = 0;
        detailIndex < details.length;
        detailIndex += 1
      ) {
        const detail = details[detailIndex];
        const source = batch[detailIndex];
        if (detail.status === 'fulfilled') {
          groups.push({ ...detail.value, unavailable: false });
        } else {
          incomplete = true;
          groups.push({
            key: `${source.serviceType}:${source.server.id}`,
            serviceType: source.serviceType,
            mediaType: getArrMediaType(
              source.serviceType,
              source.server.serviceType
            ),
            name: source.server.name,
            paths: [],
            unavailable: true,
          });
        }
      }
    }

    const comicServicesResponse = await axios
      .get<ComicServiceOption[]>('/api/v1/service/comic')
      .catch(() => {
        incomplete = true;
        return { data: [] as ComicServiceOption[] };
      });
    const kapowarrServices = comicServicesResponse.data.filter(
      (service) => service.backendType === 'kapowarr'
    );
    for (let index = 0; index < kapowarrServices.length; index += 5) {
      const batch = kapowarrServices.slice(index, index + 5);
      const details = await Promise.allSettled(
        batch.map(async (service) => {
          const { data } = await axios.get<{
            rootFolders: { path: string }[];
          }>(`/api/v1/service/comic/${service.id}/rootfolders`);
          return {
            key: `comic-kapowarr:${service.id}`,
            serviceType: 'comic-kapowarr' as const,
            mediaType: 'comics' as const,
            name: service.name,
            paths: data.rootFolders
              .map((folder) => folder.path)
              .filter(Boolean),
          };
        })
      );
      for (
        let detailIndex = 0;
        detailIndex < details.length;
        detailIndex += 1
      ) {
        const detail = details[detailIndex];
        const source = batch[detailIndex];
        if (detail.status === 'fulfilled') {
          groups.push({ ...detail.value, unavailable: false });
        } else {
          incomplete = true;
          groups.push({
            key: `comic-kapowarr:${source.id}`,
            serviceType: 'comic-kapowarr' as const,
            mediaType: 'comics' as const,
            name: source.name,
            paths: [],
            unavailable: true,
          });
        }
      }
    }

    return { groups, incomplete };
  };

const RequestRootFolderSettings = ({
  canEdit,
  value,
  onChange,
}: {
  canEdit: boolean;
  value: UserRequestRootFolders;
  onChange: (value: UserRequestRootFolders) => void;
}) => {
  const intl = useIntl();
  const { data, error, isLoading } = useSWR<RequestRootFolderOptions>(
    canEdit ? 'profile-request-root-folder-options' : null,
    loadRequestRootFolderOptions,
    { revalidateOnFocus: false, refreshInterval: 0 }
  );
  const groups = useMemo(() => {
    const configuredGroups = data?.groups ?? [];
    const knownKeys = new Set(configuredGroups.map((group) => group.key));
    const orphanGroups = Object.entries(value)
      .filter(([key]) => !knownKeys.has(key))
      .map(([key]) => ({
        key,
        serviceType: 'comic-kapowarr' as const,
        mediaType: 'comics' as const,
        name: key,
        paths: [],
        unavailable: true,
      }));
    return [...configuredGroups, ...orphanGroups];
  }, [data?.groups, value]);

  if (!canEdit) return null;

  const updateValue = (key: string, nextPath: string) => {
    const next = { ...value };
    if (nextPath) {
      next[key] = nextPath;
    } else {
      delete next[key];
    }
    onChange(next);
  };

  return (
    <div className="form-row">
      <label className="text-label">
        <span>{intl.formatMessage(messages.title)}</span>
        <span className="label-tip">
          {intl.formatMessage(messages.description)}
        </span>
      </label>
      <div className="form-input-area">
        {isLoading && <p>{intl.formatMessage(messages.loading)}</p>}
        {(error || data?.incomplete) && (
          <p role="status" className="label-tip">
            {intl.formatMessage(messages.unavailable)}
          </p>
        )}
        {groups.length > 0 && (
          <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
            {groups.map((group) => {
              const savedPath = value[group.key] ?? '';
              const savedPathUnavailable =
                !!savedPath && !group.paths.includes(savedPath);
              return (
                <div key={group.key}>
                  <label htmlFor={`request-folder-${group.key}`}>
                    {intl.formatMessage(messages.service, {
                      mediaType: intl.formatMessage(messages[group.mediaType]),
                      name: group.name,
                    })}
                  </label>
                  <div className="form-input-field">
                    <select
                      id={`request-folder-${group.key}`}
                      value={savedPath}
                      onChange={(event) =>
                        updateValue(group.key, event.target.value)
                      }
                      title={savedPath}
                    >
                      <option value="">
                        {intl.formatMessage(messages.useServiceDefault)}
                      </option>
                      {savedPathUnavailable && (
                        <option value={savedPath}>
                          {intl.formatMessage(messages.savedUnavailable)}
                        </option>
                      )}
                      {group.paths.map((path) => (
                        <option key={path} value={path}>
                          {path}
                        </option>
                      ))}
                    </select>
                  </div>
                  {savedPath && (
                    <p className="settings-form-row-description break-all">
                      {savedPath}
                    </p>
                  )}
                  {group.unavailable && !savedPath && (
                    <p className="settings-form-row-description">
                      {intl.formatMessage(messages.noFolderOptions)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default RequestRootFolderSettings;
