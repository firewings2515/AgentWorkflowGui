import { applyNodeChanges } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { fixtureSnapshot } from '../../../../contracts/fixtures/snapshot';
import { fromCanvas, toCanvas } from './graph-adapter';

const template = fixtureSnapshot.workflows[0]!;
describe('canvas reconciliation', () => {
  it('retains measured dimensions and identical nodes through unrelated domain updates', () => {
    const graph = toCanvas(template);
    graph.nodes = applyNodeChanges([{ type: 'dimensions', id: graph.nodes[0]!.id, dimensions: { width: 240, height: 180 }, setAttributes: true }], graph.nodes);
    const next = toCanvas({ ...structuredClone(template), name: '新名稱' }, null, graph);
    expect(next.nodes[0]).toBe(graph.nodes[0]);
    expect(next.nodes[0]).toMatchObject({ measured: { width: 240, height: 180 }, width: 240, height: 180 });
    const edited = { ...template, nodes: template.nodes.map((node, index) => index === 1 ? { ...node, label: '新節點名稱' } : node) };
    const reconciled = toCanvas(edited, null, next);
    expect(reconciled.nodes[0]).toBe(next.nodes[0]);
    expect(reconciled.nodes[1]).not.toBe(next.nodes[1]);
    const ownEdit = toCanvas({ ...template, nodes: template.nodes.map((node, index) => index === 0 ? { ...node, label: '已量測節點的新名稱' } : node) }, null, graph);
    expect(ownEdit.nodes[0]).toMatchObject({ measured: { width: 240, height: 180 }, width: 240, height: 180 });
    expect(ownEdit.nodes[1]).toBe(graph.nodes[1]);
  });

  it('keeps measurements through selection, keyboard movement and domain round trips', () => {
    let graph = toCanvas(template);
    const id = graph.nodes[0]!.id;
    graph = { ...graph, nodes: applyNodeChanges([{ type: 'dimensions', id, dimensions: { width: 240, height: 180 } }], graph.nodes) };
    const selection = { kind: 'node' as const, id };
    graph = toCanvas(template, selection, graph);
    expect(graph.nodes[0]?.measured).toEqual({ width: 240, height: 180 });
    const untouched = graph.nodes[1];
    for (let x = 100; x < 130; x += 5) {
      graph = { ...graph, nodes: applyNodeChanges([{ type: 'position', id, position: { x, y: 80 } }], graph.nodes) };
      const domain = fromCanvas(template, graph.nodes, graph.edges);
      graph = toCanvas(domain, selection, graph);
      expect(graph.nodes[0]).toMatchObject({ selected: true, measured: { width: 240, height: 180 }, position: { x, y: 80 } });
      expect(graph.nodes[1]).toBe(untouched);
      expect(domain.nodes[0]).not.toHaveProperty('measured');
    }
  });

  it('routes return connections above the graph with explicit direction labels', () => {
    const graph = toCanvas(template);
    const returns = graph.edges.filter(edge => edge.type === 'return');
    expect(returns.length).toBeGreaterThan(0);
    for (const edge of returns) {
      expect(edge.data?.laneY).toBeLessThan(Math.min(...template.nodes.map(node => node.position.y)));
      expect(edge.data?.label).toContain(' → ');
    }
  });
});
