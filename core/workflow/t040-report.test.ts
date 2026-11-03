// T040 r1: a retried report to root on the memory ports.
import { t040ReportRetryCases } from './testing/t040-report-cases';
import { world } from './testing/harness';

t040ReportRetryCases('memory', (workflow) => world(workflow));
