/**
 * Signed membership changes. MUST stay in sync with web/src/crypto/core.ts (applyMembership / membershipMessage):
 * the server applies the same rules so it can check the actor's signature over the *resulting* member list.
 */
import { encodeFields } from './sodium.js';
import { HttpError } from './util.js';

export type Role = 'owner' | 'admin' | 'member';
export type Action = 'create' | 'add' | 'remove' | 'leave' | 'role';
export interface Member {
  id: string;
  role: Role;
}

const deny = (msg: string) => new HttpError(403, 'membership_denied', msg);

/**
 * Compute the member list after `action`. Order = join order (new members appended).
 * For `create`, `role` carries the chat type ('direct' | 'group').
 */
export function applyMembership(prev: Member[], action: Action, actorId: string, targets: string[], role?: string | null): Member[] {
  const find = (id: string) => prev.find((m) => m.id === id);
  const actor = find(actorId);
  switch (action) {
    case 'create': {
      if (prev.length) throw deny('chat already exists');
      if (role === 'direct') {
        if (targets.length !== 1 || targets[0] === actorId) throw deny('direct chat needs exactly one peer');
        return [
          { id: actorId, role: 'member' },
          { id: targets[0], role: 'member' },
        ];
      }
      if (role !== 'group') throw deny('bad chat type');
      if (new Set(targets).size !== targets.length || targets.includes(actorId)) throw deny('duplicate members');
      return [{ id: actorId, role: 'owner' }, ...targets.map((id) => ({ id, role: 'member' as Role }))];
    }
    case 'add': {
      if (!actor || actor.role === 'member') throw deny('只有群主或管理员可以添加成员');
      if (!targets.length || new Set(targets).size !== targets.length || targets.some((t) => find(t))) throw deny('invalid targets');
      return [...prev, ...targets.map((id) => ({ id, role: 'member' as Role }))];
    }
    case 'remove': {
      if (targets.length !== 1) throw deny('remove one member at a time');
      const target = find(targets[0]);
      if (!actor || actor.role === 'member' || !target || target.id === actorId) throw deny('没有权限移除该成员');
      if (target.role === 'owner' || (target.role === 'admin' && actor.role !== 'owner')) throw deny('没有权限移除该成员');
      return prev.filter((m) => m.id !== target.id);
    }
    case 'leave': {
      if (!actor || targets.length !== 1 || targets[0] !== actorId) throw deny('invalid leave');
      const rest = prev.filter((m) => m.id !== actorId);
      if (actor.role === 'owner' && rest.length && !rest.some((m) => m.role === 'owner')) {
        const heir = rest.find((m) => m.role === 'admin') ?? rest[0];
        return rest.map((m) => (m.id === heir.id ? { ...m, role: 'owner' } : m));
      }
      return rest;
    }
    case 'role': {
      if (targets.length !== 1 || (role !== 'admin' && role !== 'member')) throw deny('invalid role change');
      const target = find(targets[0]);
      if (!actor || actor.role !== 'owner' || !target || target.id === actorId) throw deny('只有群主可以设置管理员');
      return prev.map((m) => (m.id === target.id ? { ...m, role: role as Role } : m));
    }
    default:
      throw deny('unknown action');
  }
}

export function membershipMessage(chatId: string, version: number, action: Action, actorId: string, targets: string[], role: string | null | undefined, result: Member[]) {
  return encodeFields('sc-members', [chatId, version, action, actorId, targets.join(','), role ?? '', ...result.map((m) => `${m.id}:${m.role}`)]);
}
