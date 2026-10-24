import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTrustedUrlMatcher, isTrustedSender, type IpcSenderEvent, type TrustedSender } from './ipc-guard';

const mainFrame = { url: 'http://localhost:5173/' };
const trusted: TrustedSender = {
  webContentsId: 7,
  isTrustedUrl: (url) => url.startsWith('http://localhost:5173/'),
};
const eventFrom = (overrides: Partial<IpcSenderEvent> = {}): IpcSenderEvent => ({
  sender: { id: 7, mainFrame },
  senderFrame: mainFrame,
  ...overrides,
});

describe('isTrustedSender', () => {
  it('accepts the main frame of the trusted window on a trusted page', () => {
    expect(isTrustedSender(eventFrom(), trusted)).toBe(true);
  });

  it('rejects when there is no trusted window', () => {
    expect(isTrustedSender(eventFrom(), null)).toBe(false);
  });

  it('rejects another webContents', () => {
    expect(isTrustedSender(eventFrom({ sender: { id: 8, mainFrame } }), trusted)).toBe(false);
  });

  it('rejects a missing sender frame', () => {
    expect(isTrustedSender(eventFrom({ senderFrame: null }), trusted)).toBe(false);
  });

  it('rejects a sub-frame', () => {
    const subFrame = { url: 'http://localhost:5173/embedded' };
    expect(isTrustedSender(eventFrom({ senderFrame: subFrame }), trusted)).toBe(false);
  });

  it('rejects an untrusted page URL', () => {
    const evil = { url: 'https://example.com/' };
    expect(isTrustedSender({ sender: { id: 7, mainFrame: evil }, senderFrame: evil }, trusted)).toBe(false);
  });
});

describe('createTrustedUrlMatcher', () => {
  const rendererFile =
    process.platform === 'win32' ? 'C:\\app\\out\\renderer\\index.html' : '/app/out/renderer/index.html';

  it('matches only the dev server origin when a dev URL is set', () => {
    const matches = createTrustedUrlMatcher({ devUrl: 'http://localhost:5173/', rendererFile });
    expect(matches('http://localhost:5173/')).toBe(true);
    expect(matches('http://localhost:5173/some/page?x=1')).toBe(true);
    expect(matches('http://localhost:5174/')).toBe(false);
    expect(matches('https://localhost:5173/')).toBe(false);
    expect(matches(pathToFileURL(rendererFile).href)).toBe(false);
    expect(matches('not a url')).toBe(false);
  });

  it('rejects blob: and other schemes that report the dev origin', () => {
    const matches = createTrustedUrlMatcher({ devUrl: 'http://localhost:5173/', rendererFile });
    expect(matches('blob:http://localhost:5173/6f1d2c3e-0000-4000-8000-000000000000')).toBe(false);
    expect(matches('filesystem:http://localhost:5173/temporary/x')).toBe(false);
  });

  it('matches only the packaged renderer page otherwise', () => {
    const matches = createTrustedUrlMatcher({ devUrl: undefined, rendererFile });
    const appUrl = pathToFileURL(rendererFile).href;
    expect(matches(appUrl)).toBe(true);
    expect(matches(`${appUrl}#/route?x=1`)).toBe(true);
    expect(matches(pathToFileURL(rendererFile.replace('index', 'other')).href)).toBe(false);
    expect(matches('http://localhost:5173/')).toBe(false);
    expect(matches('about:blank')).toBe(false);
  });
});
