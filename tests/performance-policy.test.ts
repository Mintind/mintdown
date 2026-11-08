import { expect, it } from 'vitest';
import { estimateDocumentCost, PerformanceGovernor, SourceSyntaxMonitor } from '../src/editor/performancePolicy';

it('uses structural complexity as well as length for the initial tier', () => {
  const plain = '正文'.repeat(30_000);
  const mixed = '| 中文 | 内容 |\n'.repeat(4_000);
  expect(plain.length).toBe(60_000);
  expect(estimateDocumentCost(mixed).weighted).toBeGreaterThan(150_000);
  expect(new PerformanceGovernor(plain, 0).tier).toBe('normal');
  expect(new PerformanceGovernor(mixed, 0).tier).toBe('source');
  expect(new PerformanceGovernor('正文'.repeat(50_000), 0).tier).toBe('light');
});

it('requires consecutive slow edits, then degrades normal to light to source', () => {
  const governor = new PerformanceGovernor('正文', 0);
  expect(governor.observeVisual(70, 1)).toBe('normal');
  expect(governor.observeVisual(20, 2)).toBe('normal');
  expect(governor.observeVisual(70, 3)).toBe('normal');
  expect(governor.observeVisual(70, 4)).toBe('normal');
  expect(governor.observeVisual(70, 5)).toBe('light');
  expect(governor.observeVisual(90, 6)).toBe('light');
  expect(governor.observeVisual(90, 7)).toBe('light');
  expect(governor.observeVisual(90, 8)).toBe('source');
});

it('recovers only after idle time, safe interaction, and lower document cost', () => {
  const governor = new PerformanceGovernor('正文'.repeat(100_000), 0);
  expect(governor.tier).toBe('source');
  expect(governor.canRecover('正文', 20_000, 0, false)).toBe(false);
  expect(governor.canRecover('正文', 10_000, 0, true)).toBe(false);
  expect(governor.canRecover('正文'.repeat(100_000), 20_000, 0, true)).toBe(false);
  expect(governor.canRecover('正文', 20_000, 15_000, true)).toBe(false);
  expect(governor.canRecover('正文', 20_000, 0, true)).toBe(true);
  governor.recovered(20_000);
  expect(governor.tier).toBe('light');
  expect(governor.canRecover('正文', 40_000, 0, true)).toBe(false);
});

it('keeps a manual visual request distinct from automatic source recovery', () => {
  const governor = new PerformanceGovernor('正文'.repeat(100_000), 0);
  governor.manualVisual('正文'.repeat(100_000), 20_000);
  expect(governor.tier).toBe('light');
  expect(governor.observeVisual(90, 20_001)).toBe('light');
  expect(governor.observeVisual(90, 20_002)).toBe('light');
  expect(governor.observeVisual(90, 20_003)).toBe('source');
});

it('simplifies source syntax only after three consecutive slow edits', () => {
  const monitor = new SourceSyntaxMonitor();
  expect(monitor.observe(100)).toBe(false);
  expect(monitor.observe(20)).toBe(false);
  expect(monitor.observe(101)).toBe(false);
  expect(monitor.observe(102)).toBe(false);
  expect(monitor.observe(103)).toBe(true);
  monitor.reset();
  expect(monitor.observe(104)).toBe(false);
});
