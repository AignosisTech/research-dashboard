import type { StimulusVersion } from '@/lib/api/research';

export type StimulusLanguage = 'english' | 'hindi';

/**
 * Stimulus playlists per version: "1" = original AST video, "2" = new AST video.
 * Single source of truth — consumed by VideoPlayer (playback) and the offline
 * pack downloader (resourceCache), so what plays is exactly what gets cached.
 */
export const STIMULUS_URLS: Record<StimulusVersion, Record<StimulusLanguage, string>> = {
  '1': {
    english:
      'https://aignosis-test-videos.storage.googleapis.com/Test_Videos/ast%20eng%20vid%20hls%20format/playlist.m3u8',
    hindi:
      'https://aignosis-test-videos.storage.googleapis.com/Test_Videos/ast%20hindi%20vid%20hls%20format/playlist.m3u8',
  },
  '2': {
    english:
      'https://aignosis-test-videos.storage.googleapis.com/Test_Videos/new%20ast%20eng%20vid%20hls%20format/playlist.m3u8',
    hindi:
      'https://aignosis-test-videos.storage.googleapis.com/Test_Videos/new%20ast%20hindi%20vid%20hls%20format/playlist.m3u8',
  },
};

/**
 * Playlist durations in seconds, measured from each playlist's #EXTINF entries.
 * Re-measure if the GCS videos are ever replaced.
 */
export const STIMULUS_DURATIONS_SEC: Record<StimulusVersion, Record<StimulusLanguage, number>> = {
  '1': { english: 258.5, hindi: 253.8 },
  '2': { english: 169.4, hindi: 167.1 },
};

export const STIMULUS_VERSIONS: StimulusVersion[] = ['1', '2'];
export const STIMULUS_LANGUAGES: StimulusLanguage[] = ['english', 'hindi'];

/** Cache-marker key for one (language, version) stimulus download. */
export const hlsCacheKey = (language: string, version: StimulusVersion) => `${language}:${version}`;
