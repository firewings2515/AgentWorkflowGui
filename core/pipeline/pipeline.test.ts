// T032 task pipeline on the memory ports.
import { world } from '../workflow/testing/harness';
import { t032Cases } from './testing/t032-cases';

t032Cases('memory', (workflow) => world(workflow));
