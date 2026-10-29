// T024 review r2 reproductions on the memory ports.
import { r2Cases } from './testing/r2-cases';
import { world } from './testing/harness';

r2Cases('memory', (workflow) => world(workflow));
