import express from "express";
import crypto from "node:crypto";

interface RealmState {
  name: string;
  roles: Array<{ id: string; name: string; description?: string }>;
  groups: Map<string, { id: string; name: string; path: string }>;
  userGroups: Map<string, string[]>; // userId -> groupId[]
  userRoles: Map<string, Array<{ id: string; name: string }>>; // userId -> roles[]
}

let realms: Map<string, RealmState>;

function initState() {
  realms = new Map();
}

export function resetState() {
  initState();
}

function getRealm(name: string): RealmState | undefined {
  return realms.get(name);
}

export function createKcAdminMock() {
  initState();

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // POST /realms/master/protocol/openid-connect/token — admin auth
  app.post(
    "/realms/:realm/protocol/openid-connect/token",
    express.urlencoded({ extended: true }),
    (_req, res) => {
      res.json({
        access_token: "mock-kc-admin-token",
        token_type: "Bearer",
        expires_in: 60,
      });
    },
  );

  // POST /admin/realms — create realm
  app.post("/admin/realms", (req, res) => {
    const body = req.body;
    const realmName = body.realm;
    if (!realmName) {
      return res.status(400).json({ error: "realm name required" });
    }
    if (realms.has(realmName)) {
      return res
        .status(409)
        .json({ errorMessage: `Conflict detected. See logs for details` });
    }

    // Extract roles from the realm representation
    const realmRoles: Array<{ id: string; name: string; description?: string }> =
      (body.roles?.realm || []).map(
        (r: { name: string; description?: string }) => ({
          id: crypto.randomUUID(),
          name: r.name,
          description: r.description,
        }),
      );

    // Extract groups from the realm representation
    const groups = new Map<string, { id: string; name: string; path: string }>();
    if (Array.isArray(body.groups)) {
      for (const g of body.groups) {
        const id = crypto.randomUUID();
        groups.set(g.name, { id, name: g.name, path: `/${g.name}` });
      }
    }

    realms.set(realmName, {
      name: realmName,
      roles: realmRoles,
      groups,
      userGroups: new Map(),
      userRoles: new Map(),
    });

    res.status(201).json({});
  });

  // GET /admin/realms — list realms
  app.get("/admin/realms", (_req, res) => {
    const list = Array.from(realms.values()).map((r) => ({
      realm: r.name,
      enabled: true,
    }));
    res.json(list);
  });

  // GET /admin/realms/:realm — get realm
  app.get("/admin/realms/:realm", (req, res) => {
    const realm = getRealm(req.params.realm);
    if (!realm) {
      return res
        .status(404)
        .json({ error: `Realm not found: ${req.params.realm}` });
    }
    res.json({ realm: realm.name, enabled: true });
  });

  // POST /admin/realms/:realm/groups — create group
  app.post("/admin/realms/:realm/groups", (req, res) => {
    const realm = getRealm(req.params.realm);
    if (!realm) {
      return res.status(404).json({ error: "Realm not found" });
    }
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: "group name required" });
    }
    if (realm.groups.has(name)) {
      return res
        .status(409)
        .json({ errorMessage: `Top level group named '${name}' already exists.` });
    }
    const id = crypto.randomUUID();
    realm.groups.set(name, { id, name, path: `/${name}` });
    res.status(201).set("Location", `/admin/realms/${req.params.realm}/groups/${id}`).json({});
  });

  // GET /admin/realms/:realm/groups — list groups
  app.get("/admin/realms/:realm/groups", (req, res) => {
    const realm = getRealm(req.params.realm);
    if (!realm) {
      return res.status(404).json({ error: "Realm not found" });
    }
    res.json(Array.from(realm.groups.values()));
  });

  // PUT /admin/realms/:realm/users/:userId/groups/:groupId — add user to group
  app.put(
    "/admin/realms/:realm/users/:userId/groups/:groupId",
    (req, res) => {
      const realm = getRealm(req.params.realm);
      if (!realm) {
        return res.status(404).json({ error: "Realm not found" });
      }
      const { userId, groupId } = req.params;
      const existing = realm.userGroups.get(userId) || [];
      if (!existing.includes(groupId)) {
        existing.push(groupId);
      }
      realm.userGroups.set(userId, existing);
      res.status(204).end();
    },
  );

  // GET /admin/realms/:realm/users/:userId/groups — get user groups
  app.get("/admin/realms/:realm/users/:userId/groups", (req, res) => {
    const realm = getRealm(req.params.realm);
    if (!realm) {
      return res.status(404).json({ error: "Realm not found" });
    }
    const groupIds = realm.userGroups.get(req.params.userId) || [];
    const groups = groupIds
      .map((gid) =>
        Array.from(realm.groups.values()).find((g) => g.id === gid),
      )
      .filter(Boolean);
    res.json(groups);
  });

  // GET /admin/realms/:realm/roles — list realm roles
  app.get("/admin/realms/:realm/roles", (req, res) => {
    const realm = getRealm(req.params.realm);
    if (!realm) {
      return res.status(404).json({ error: "Realm not found" });
    }
    res.json(realm.roles);
  });

  // GET /admin/realms/:realm/roles/:roleName — get role by name
  app.get("/admin/realms/:realm/roles/:roleName", (req, res) => {
    const realm = getRealm(req.params.realm);
    if (!realm) {
      return res.status(404).json({ error: "Realm not found" });
    }
    const role = realm.roles.find((r) => r.name === req.params.roleName);
    if (!role) {
      return res
        .status(404)
        .json({ error: `Could not find role: ${req.params.roleName}` });
    }
    res.json({ id: role.id, name: role.name });
  });

  // POST /admin/realms/:realm/users/:userId/role-mappings/realm — assign realm roles
  app.post(
    "/admin/realms/:realm/users/:userId/role-mappings/realm",
    (req, res) => {
      const realm = getRealm(req.params.realm);
      if (!realm) {
        return res.status(404).json({ error: "Realm not found" });
      }
      const { userId } = req.params;
      const rolesToAssign: Array<{ id: string; name: string }> = req.body;
      const existing = realm.userRoles.get(userId) || [];
      for (const role of rolesToAssign) {
        if (!existing.find((r) => r.id === role.id)) {
          existing.push({ id: role.id, name: role.name });
        }
      }
      realm.userRoles.set(userId, existing);
      res.status(204).end();
    },
  );

  // GET /admin/realms/:realm/users/:userId/role-mappings/realm — get user realm roles
  app.get(
    "/admin/realms/:realm/users/:userId/role-mappings/realm",
    (req, res) => {
      const realm = getRealm(req.params.realm);
      if (!realm) {
        return res.status(404).json({ error: "Realm not found" });
      }
      const roles = realm.userRoles.get(req.params.userId) || [];
      res.json(roles);
    },
  );

  return { app };
}
