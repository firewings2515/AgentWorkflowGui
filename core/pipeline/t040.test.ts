// T040 G-11 (B) on the memory ports.
import { world } from '../workflow/testing/harness';
import { t040NoticeCases } from './testing/t040-cases';

t040NoticeCases('memory', (workflow) => world(workflow));
