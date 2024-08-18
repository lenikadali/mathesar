import { getContext, setContext } from 'svelte';
import { type Readable, type Writable, derived, writable } from 'svelte/store';

import userApi, { type User } from '@mathesar/api/rest/users';
import { Collaborator } from '@mathesar/models/Collaborator';
import { ConfiguredRole } from '@mathesar/models/ConfiguredRole';
import type { Database } from '@mathesar/models/Database';
import { Role } from '@mathesar/models/Role';
import AsyncStore from '@mathesar/stores/AsyncStore';
import { CancellablePromise, ImmutableMap } from '@mathesar-component-library';

const contextKey = Symbol('database settings store');

export type CombinedLoginRole = {
  name: string;
  role?: Role;
  configuredRole?: ConfiguredRole;
};

// TODO: Make CancellablePromise chainable
const getUsersPromise = () => {
  const promise = userApi.list();
  return new CancellablePromise<ImmutableMap<User['id'], User>>(
    (resolve, reject) => {
      promise
        .then(
          (response) =>
            resolve(
              new ImmutableMap(response.results.map((user) => [user.id, user])),
            ),
          (err) => reject(err),
        )
        .catch((err) => reject(err));
    },
    () => promise.cancel(),
  );
};

class DatabaseSettingsContext {
  database: Database;

  configuredRoles;

  roles;

  combinedLoginRoles: Readable<CombinedLoginRole[]>;

  collaborators;

  users: AsyncStore<void, ImmutableMap<User['id'], User>>;

  constructor(database: Database) {
    this.database = database;
    this.configuredRoles = database.fetchConfiguredRoles();
    this.roles = database.fetchRoles();
    this.combinedLoginRoles = derived(
      [this.roles, this.configuredRoles],
      ([$roles, $configuredRoles]) => {
        const isLoading = $configuredRoles.isLoading || $roles.isLoading;
        if (isLoading) {
          return [];
        }
        const isStable = $configuredRoles.isStable && $roles.isStable;
        const loginRoles = $roles.resolvedValue?.filterValues(
          (value) => value.login,
        );
        const configuredRoles = $configuredRoles.resolvedValue?.mapKeys(
          (cr) => cr.name,
        );
        if (isStable && loginRoles && configuredRoles) {
          return [...loginRoles.values()].map((role) => ({
            name: role.name,
            role,
            configuredRole: configuredRoles.get(role.name),
          }));
        }
        if ($configuredRoles.isStable && configuredRoles) {
          [...configuredRoles.values()].map((configuredRole) => ({
            name: configuredRole.name,
            configuredRole,
          }));
        }
        return [];
      },
    );
    this.collaborators = database.fetchCollaborators();
    this.users = new AsyncStore(getUsersPromise);
  }

  async configureRole(combinedLoginRole: CombinedLoginRole, password: string) {
    if (combinedLoginRole.configuredRole) {
      return combinedLoginRole.configuredRole.setPassword(password);
    }

    if (combinedLoginRole.role) {
      const configuredRole = await combinedLoginRole.role.configure(password);
      this.configuredRoles.updateResolvedValue((configuredRoles) =>
        configuredRoles.with(configuredRole.id, configuredRole),
      );
    }

    return undefined;
  }

  async removeConfiguredRole(configuredRole: ConfiguredRole) {
    await configuredRole.delete();
    this.configuredRoles.updateResolvedValue((configuredRoles) =>
      configuredRoles.without(configuredRole.id),
    );
  }

  async addCollaborator(
    userId: User['id'],
    configuredRoleId: ConfiguredRole['id'],
  ) {
    const newCollaborator = await this.database.addCollaborator(
      userId,
      configuredRoleId,
    );
    this.collaborators.updateResolvedValue((collaborators) =>
      collaborators.with(newCollaborator.id, newCollaborator),
    );
  }

  async updateRoleForCollaborator(
    collaborator: Collaborator,
    configuredRoleId: ConfiguredRole['id'],
  ) {
    const updatedCollaborator =
      await collaborator.setConfiguredRole(configuredRoleId);
    this.collaborators.updateResolvedValue((collaborators) =>
      collaborators.with(updatedCollaborator.id, updatedCollaborator),
    );
  }

  async deleteCollaborator(collaborator: Collaborator) {
    await collaborator.delete();
    this.collaborators.updateResolvedValue((c) => c.without(collaborator.id));
  }
}

export function getDatabaseSettingsContext(): Readable<DatabaseSettingsContext> {
  const store = getContext<Writable<DatabaseSettingsContext>>(contextKey);
  if (store === undefined) {
    throw Error('Database settings context has not been set');
  }
  return store;
}

export function setDatabaseSettingsContext(
  database: Database,
): Readable<DatabaseSettingsContext> {
  let store = getContext<Writable<DatabaseSettingsContext>>(contextKey);
  const databaseSettingsContext = new DatabaseSettingsContext(database);
  if (store !== undefined) {
    store.set(databaseSettingsContext);
    return store;
  }
  store = writable(databaseSettingsContext);
  setContext(contextKey, store);
  return store;
}
