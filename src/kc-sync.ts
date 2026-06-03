import { config } from "./config.js";
import {
  assignRealmRoles,
  addUserToGroupInRealm,
  getGroupsInRealm,
  setUserAttributeInRealm,
} from "./kc-admin.js";
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

  // 3. Write DIGIT mobile back to KC user as the `phoneNumber` attribute.
  //
  // SSO citizens (Google) arrive with no phone_number claim in their JWT.
  // The overlay synthesizes one when provisioning into egov-user (see
  // createUser in digit-client.ts) but that synthesized value lives only
  // in DIGIT. Without writing it back, the SPA's `auth.user.mobileNumber`
  // stays empty on the next session, and downstream lookups keyed by
  // mobile (e.g. PGR `/_search?mobileNumber=...` in the My Complaints
  // page) return empty.
  //
  // Writing to `attributes.phoneNumber` makes KC's built-in `phone`
  // client scope surface it as the `phone_number` JWT claim. So the
  // NEXT JWT mint for this user carries the right phone, the SPA reads
  // it natively, no SPA changes needed.
  //
  // Fire-and-forget on error: a missing phone attribute is a downgrade,
  // not a fatal — the rest of provisioning already succeeded.
  if (digitUser.mobileNumber) {
    setUserAttributeInRealm(root, kcSub, "phoneNumber", digitUser.mobileNumber).catch(
      (err: Error) => {
        console.warn(
          `[KC-SYNC] phoneNumber write failed for sub=${kcSub.slice(0, 8)} ` +
            `(mobile=${digitUser.mobileNumber}):`,
            err.message,
        );
      },
    );
  }
}
