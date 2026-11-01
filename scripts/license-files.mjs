// What counts as a licence or notice file in a package (shared by the list generator and the check).
import { extname } from 'node:path';

const NAME = /^(licen[sc]e|notice|copying|unlicense)(?:[-_.][\w.-]*)?$/i;
const CODE = new Set(['.js', '.cjs', '.mjs', '.json', '.ts', '.map', '.h', '.c', '.cc', '.cpp', '.py']);

export const isLicenceFile = (name) => NAME.test(name) && !CODE.has(extname(name).toLowerCase());
