export const APP_NAME = 'TailorIT';

/**
 * v34 MCPDIR: the release this build is (semver, no "v"), bumped at each release with CHANGELOG.md's heading. The MCP
 * server reports it as its version (serverInfo.version); anything else that names the app's version reads it here.
 */
export const APP_RELEASE = '3.7.0';

export * from './errors';
export * from './list';
export * from './time';
