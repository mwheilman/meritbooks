/**
 * Navigation + planes integrity guards. These are the cheap invariants that catch the
 * blank-sidebar / dead-link class of bug: every nav href must be unique and non-empty,
 * every group label must be non-empty and unique, and every group a PLANE references
 * must actually exist in the navigation (a typo there empties a plane's sidebar).
 */

import { describe, it, expect } from 'vitest';
import { navigation } from './navigation';
import { PLANES, PLANE_ORDER } from './planes';

const allItems = navigation.flatMap((g) => g.items);
const groupLabels = navigation.map((g) => g.label);

describe('navigation items', () => {
  it('every item has a non-empty label and href', () => {
    for (const item of allItems) {
      expect(item.label.trim().length).toBeGreaterThan(0);
      expect(item.href.trim().length).toBeGreaterThan(0);
    }
  });

  it('every href starts with "/" (absolute app route)', () => {
    for (const item of allItems) {
      expect(item.href.startsWith('/')).toBe(true);
    }
  });

  it('every href is unique (no two nav entries point at the same route)', () => {
    const hrefs = allItems.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('every item carries an icon component', () => {
    for (const item of allItems) {
      expect(item.icon).toBeTruthy();
    }
  });

  it('no group is empty', () => {
    for (const group of navigation) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });
});

describe('navigation groups', () => {
  it('every group label is non-empty', () => {
    for (const label of groupLabels) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });

  it('group labels are unique', () => {
    expect(new Set(groupLabels).size).toBe(groupLabels.length);
  });
});

describe('planes reference real navigation groups', () => {
  const known = new Set(groupLabels);

  it('every group named by a plane exists in navigation (guards blank sidebar)', () => {
    for (const plane of Object.values(PLANES)) {
      for (const g of plane.groups) {
        expect(known.has(g), `plane "${plane.id}" references unknown group "${g}"`).toBe(true);
      }
    }
  });

  it('every navigation group is surfaced by at least one plane (no orphan group)', () => {
    const referenced = new Set(Object.values(PLANES).flatMap((p) => p.groups));
    for (const label of groupLabels) {
      expect(referenced.has(label), `group "${label}" is not shown in any plane`).toBe(true);
    }
  });

  it('PLANE_ORDER lists every defined plane exactly once', () => {
    expect([...PLANE_ORDER].sort()).toEqual(Object.keys(PLANES).sort());
    expect(new Set(PLANE_ORDER).size).toBe(PLANE_ORDER.length);
  });

  it('each plane names at least one group', () => {
    for (const plane of Object.values(PLANES)) {
      expect(plane.groups.length).toBeGreaterThan(0);
    }
  });
});
