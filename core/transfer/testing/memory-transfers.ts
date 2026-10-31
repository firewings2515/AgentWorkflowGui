// Memory repositories whose transfer proposals follow the port (core/ports/repository.ts, C-12) as T022's
// SQLite repository does: only the link to the delivery side is saved, and every read takes the provision,
// the payload's delivery and the created session from the delivery store. Every read is checked against
// the contracts, so a step that leaves a proposal the schema refuses fails the test that took it.
import { TransferProposal } from '../../../contracts';
import type { DeliveryStore, SaveResult } from '../../ports';
import { MemoryRepositories } from '../../sessions/testing/memory-repositories';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** What is saved: the proposal without its delivery side, and the provision link as fixed at approval. */
const stored = (proposal: TransferProposal): TransferProposal => {
  const { provision, ...rest } = copy(proposal);
  delete rest.delivery;
  delete rest.createdSessionId;
  return { ...rest, ...(provision !== undefined && { provision: { ...provision, state: 'pending' } }) };
};

export class TransferRepositories extends MemoryRepositories {
  private readonly proposals = new Map<string, TransferProposal>();

  constructor(private readonly deliveries: DeliveryStore) {
    super();
  }

  override readonly transfers = {
    get: async (id: string) => {
      const saved = this.proposals.get(id);
      return saved === undefined ? undefined : this.project(saved);
    },
    list: async () => {
      const all = [...this.proposals.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      return Promise.all(all.map((p) => this.project(p)));
    },
    create: (proposal: TransferProposal) => {
      if (this.proposals.has(proposal.id)) return Promise.resolve('exists' as const);
      this.proposals.set(proposal.id, stored({ ...proposal, revision: 0 }));
      return Promise.resolve('created' as const);
    },
    update: async (proposal: TransferProposal, expectedRevision: number): Promise<SaveResult<TransferProposal>> => {
      if (proposal.revision !== expectedRevision + 1) throw new TypeError('a transfer update carries revision expectedRevision + 1');
      const current = this.proposals.get(proposal.id);
      if (current?.revision !== expectedRevision) return { status: 'stale', current: current === undefined ? undefined : await this.project(current) };
      // Checked before it replaces anything, as the SQLite repository refuses an invalid record.
      const next = stored(proposal);
      const record = await this.project(next);
      this.proposals.set(proposal.id, next);
      return { status: 'saved', record };
    },
  };

  private async project(saved: TransferProposal): Promise<TransferProposal> {
    const payload = await this.deliveries.get(saved.operationId);
    const provision = saved.provision === undefined ? undefined : await this.deliveries.get(saved.provision.operationId);
    if (payload !== undefined && (payload.kind !== 'transfer' || payload.payloadHash !== saved.payloadHash || payload.proposalRevision !== saved.approvedRevision)) {
      throw new Error('delivery:approval-mismatch');
    }
    const link = provision?.target.provision ?? saved.provision;
    return TransferProposal.parse({
      ...copy(saved),
      ...(link !== undefined && { provision: link }),
      ...(payload !== undefined && { delivery: payload.delivery }),
      ...(provision?.delivery.state === 'sent' && provision.target.sessionId !== undefined && { createdSessionId: provision.target.sessionId }),
    });
  }
}
