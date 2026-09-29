import type { AllSettings } from '@server/lib/settings';

const addEpisodeWatchAheadJob = (settings: any): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes('0018_episode_watch_ahead_job')
  ) {
    return settings;
  }

  settings.jobs ??= {};
  settings.jobs['jellyfin-watch-ahead'] ??= {
    schedule: '*/30 * * * * *',
  };
  settings.migrations ??= [];
  settings.migrations.push('0018_episode_watch_ahead_job');
  return settings;
};

export default addEpisodeWatchAheadJob;
