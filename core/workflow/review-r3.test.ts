// T024 review r3 reproductions on the memory ports.
import { world } from './testing/harness';
import { r3Cases } from './testing/r3-cases';

r3Cases('memory', (workflow) => world(workflow));
