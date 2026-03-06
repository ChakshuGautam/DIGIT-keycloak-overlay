import { config } from "./config.js";
import { assignRealmRoles, addUserToGroupInRealm, getGroupsInRealm } from "./kc-admin.js";
import type { DigitUser } from "./types.js";

export async function syncUserToKc(
  kcSub: string,
  digitUser: DigitUser,
  tenantId: string,
): Promise<void> {
  if (!config.tenantSyncEnabled) return;

  const root = tenantId.split(".")[0];

  // 1. Sync realm roles
  const roleCodes = digitUser.roles.map(r => r.code);
  if (roleCodes.length > 0) {
    await assignRealmRoles(root, kcSub, roleCodes);
  }

  // 2. Assign to city group (if city-level tenant)
  if (tenantId.includes(".")) {
    const groups = await getGroupsInRealm(root);
    const cityGroup = groups.find(g => g.name === tenantId);
    if (cityGroup) {
      await addUserToGroupInRealm(root, kcSub, cityGroup.id);
    }
  }
}
