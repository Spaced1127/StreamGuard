import { describe, expect, it } from 'vitest';
import {
  buildBackupMasterUrl,
  buildTokenRequestBody,
  buildTokenRequestBodyFromTemplate,
  DEFAULT_TOKEN_QUERY_HASH,
  parseTokenResponse,
  PLAYER_TYPES,
} from './backup';

describe('buildTokenRequestBody', () => {
  it('builds a web token request for source player types', () => {
    const body = buildTokenRequestBody('hasanabi', 'site', DEFAULT_TOKEN_QUERY_HASH);
    expect(body.operationName).toBe('PlaybackAccessToken');
    expect(body.variables).toEqual({
      isLive: true,
      login: 'hasanabi',
      isVod: false,
      vodID: '',
      playerType: 'site',
      platform: 'web',
    });
    expect(body.extensions.persistedQuery.sha256Hash).toBe(DEFAULT_TOKEN_QUERY_HASH);
  });

  it('uses the android platform for autoplay', () => {
    const body = buildTokenRequestBody('foo', 'autoplay', 'hash');
    expect(body.variables.platform).toBe('android');
    expect(body.variables.playerType).toBe('autoplay');
  });

  it('starts with a source type before the low-quality fallback', () => {
    expect(PLAYER_TYPES[0]).toBe('site');
    expect(PLAYER_TYPES).toContain('autoplay');
  });
});

describe('parseTokenResponse', () => {
  it('accepts the nested GraphQL shape', () => {
    expect(
      parseTokenResponse({
        data: { streamPlaybackAccessToken: { value: 'v', signature: 's' } },
      }),
    ).toEqual({ value: 'v', signature: 's' });
  });

  it('accepts the flat shape', () => {
    expect(
      parseTokenResponse({ streamPlaybackAccessToken: { value: 'v2', signature: 's2' } }),
    ).toEqual({ value: 'v2', signature: 's2' });
  });

  it('rejects missing or malformed tokens', () => {
    expect(parseTokenResponse(null)).toBeNull();
    expect(parseTokenResponse({ data: {} })).toBeNull();
    expect(parseTokenResponse({ data: { streamPlaybackAccessToken: { value: 1 } } })).toBeNull();
  });
});

describe('buildTokenRequestBodyFromTemplate', () => {
  it('preserves extra variables and overrides player fields', () => {
    const template = {
      operationName: 'PlaybackAccessToken',
      variables: {
        login: 'old',
        isLive: true,
        isVod: false,
        vodID: '',
        playerType: 'site',
        platform: 'web',
        playerBackend: 'mediaplayer',
        extra: 'keep',
      },
      extensions: { persistedQuery: { version: 1, sha256Hash: 'captured' } },
    };

    const body = buildTokenRequestBodyFromTemplate(template, 'newchannel', 'autoplay', 'fallback');

    expect(body.variables as unknown as Record<string, unknown>).toMatchObject({
      login: 'newchannel',
      playerType: 'autoplay',
      platform: 'android',
      playerBackend: 'mediaplayer',
      extra: 'keep',
    });
    expect(body.extensions.persistedQuery.sha256Hash).toBe('captured');
  });

  it('falls back to the standard body without a captured template', () => {
    const body = buildTokenRequestBodyFromTemplate(null, 'foo', 'popout', 'hash');
    expect(body.variables.login).toBe('foo');
    expect(body.variables.platform).toBe('web');
    expect(body.extensions.persistedQuery.sha256Hash).toBe('hash');
  });
});

describe('buildBackupMasterUrl', () => {
  it('replaces credentials and strips parent_domains', () => {
    const result = new URL(
      buildBackupMasterUrl(
        'https://usher.ttvnw.net/api/channel/hls/foo.m3u8?allow_source=true&sig=old&token=old&parent_domains=example.com',
        { value: 'new-token', signature: 'new-sig' },
      ),
    );

    expect(result.searchParams.get('sig')).toBe('new-sig');
    expect(result.searchParams.get('token')).toBe('new-token');
    expect(result.searchParams.has('parent_domains')).toBe(false);
    expect(result.searchParams.get('allow_source')).toBe('true');
  });
});
