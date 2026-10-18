/*
 * The HushOS version this build carries: the root package.json's, which the release pull
 * request sets (CONTRIBUTING.md, Releasing). Read at build time, so the browser bundle and the
 * server agree without an environment variable. Between releases a build still says the last
 * release's version; the commit (x-hushos-release) is what tells two builds apart.
 */
import { version } from '../../../../package.json';

export const HUSHOS_VERSION: string = version;
