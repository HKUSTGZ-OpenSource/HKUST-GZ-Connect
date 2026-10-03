'use strict';

const crypto = require('node:crypto');
const {
  CustomProfileIndexStore,
  sameCustomProfileIndexReceipt,
} = require('../registry/custom-profile-index');
const { CustomProfileMaterializer, sameCustomProfileFileReceipt } =
  require('./custom-profile-materializer');
const {
  createPreparedCustomProfileProvisioning,
  markCustomProfileIndexed,
  markCustomProfileMaterialized,
} = require('./custom-profile-provisioning-journal');
const {
  createCustomProfileProvisioningIdentity,
  createCustomProfileProvisioningPlan,
  CUSTOM_PROFILE_FILE_IDS,
} = require('./custom-profile-provisioning-plan');
const {
  CustomProfileProvisioningJournalStore,
} = require('./custom-profile-provisioning-store');
const { validateSchoolProfileDocument } = require('../schema/school-profile-schema');

class CustomProfileProvisioningRuntime {
  constructor({
    userData,
    profileStorageEffects,
    journalStore = null,
    indexStore = null,
    materializer = null,
    randomBytes = crypto.randomBytes,
    now = Date.now,
  } = {}) {
    if (typeof randomBytes !== 'function' || typeof now !== 'function') {
      throw new TypeError('custom Profile provisioning runtime dependencies are invalid');
    }
    this.userData = userData;
    this.profileStorageEffects = profileStorageEffects;
    this.journalStore = journalStore || new CustomProfileProvisioningJournalStore({
      userData, profileStorageEffects,
    });
    this.indexStore = indexStore || new CustomProfileIndexStore({ userData, profileStorageEffects });
    this.materializer = materializer || new CustomProfileMaterializer({ profileStorageEffects });
    this.randomBytes = randomBytes;
    this.now = now;
    this.running = false;
  }

  begin(confirmation) {
    return this.#singleFlight(() => {
      if (this.journalStore.read() !== null) {
        throw new Error('custom Profile provisioning is already pending');
      }
      const identity = createCustomProfileProvisioningIdentity({
        profileId: confirmation?.draftProfileId,
        randomBytes: this.randomBytes,
      });
      const plan = createCustomProfileProvisioningPlan({
        userData: this.userData,
        confirmation,
        identity,
        now: this.now,
      });
      const fileReceipts = this.materializer.expected(plan);
      const indexTransition = this.indexStore.planAdd(this.#indexEntry(plan));
      const prepared = createPreparedCustomProfileProvisioning({
        plan,
        fileReceipts,
        indexTransition,
      });
      const stored = this.journalStore.prepare(prepared);
      if (!stored?.prepared || JSON.stringify(this.journalStore.read()) !== JSON.stringify(prepared)) {
        throw new Error('custom Profile provisioning prepare was not confirmed');
      }
      return this.#resume(prepared);
    });
  }

  recover() {
    return this.#singleFlight(() => {
      const journal = this.journalStore.read();
      if (journal === null) return Object.freeze({ ok: true, status: 'none' });
      return this.#resume(journal);
    });
  }

  #resume(journalValue) {
    let journal = journalValue;
    const plan = this.#planFromJournal(journal);
    const expected = this.materializer.expected(plan);
    if (CUSTOM_PROFILE_FILE_IDS.some((id) => (
      !sameCustomProfileFileReceipt(expected[id], journal.fileReceipts[id])
    ))) {
      throw new Error('custom Profile provisioning file receipts do not match the journal');
    }

    if (journal.state === 'prepared') {
      this.materializer.materialize(plan, journal.fileReceipts);
      const materialized = markCustomProfileMaterialized(journal, { now: this.now });
      const stored = this.journalStore.markMaterialized(materialized);
      if (!stored?.materialized ||
          JSON.stringify(this.journalStore.read()) !== JSON.stringify(materialized)) {
        throw new Error('custom Profile materialized transition was not confirmed');
      }
      journal = materialized;
    }

    if (journal.state === 'materialized') {
      if (!this.materializer.verify(plan, journal.fileReceipts)) {
        throw new Error('custom Profile destination changed after materialization');
      }
      if (!this.indexStore.applyAdd(journal.indexTransition.entry, journal.indexTransition) ||
          !sameCustomProfileIndexReceipt(
            this.indexStore.receipt(),
            journal.indexTransition.after,
          )) {
        throw new Error('custom Profile index commit was not confirmed');
      }
      const indexed = markCustomProfileIndexed(journal, { now: this.now });
      const stored = this.journalStore.markIndexed(indexed);
      if (!stored?.indexed || JSON.stringify(this.journalStore.read()) !== JSON.stringify(indexed)) {
        throw new Error('custom Profile indexed transition was not confirmed');
      }
      journal = indexed;
    }

    if (journal.state !== 'indexed' || !this.materializer.verify(plan, journal.fileReceipts) ||
        !sameCustomProfileIndexReceipt(this.indexStore.receipt(), journal.indexTransition.after) ||
        !this.indexStore.read().entries.some((entry) => (
          entry.profileId === journal.identity.profileId &&
          entry.profileKey === journal.identity.profileKey
        ))) {
      throw new Error('custom Profile provisioning final authority is incomplete');
    }
    if (this.journalStore.clearIndexed() !== true) {
      throw new Error('custom Profile provisioning journal was not cleared');
    }
    return Object.freeze({
      ok: true,
      status: 'provisioned',
      profileId: journal.identity.profileId,
      context: plan.context,
    });
  }

  #planFromJournal(journal) {
    const profile = validateSchoolProfileDocument(journal.profileDocument);
    return createCustomProfileProvisioningPlan({
      userData: this.userData,
      confirmation: {
        draftProfileId: journal.identity.profileId,
        normalizedOrigin: profile.gateway.origin.origin,
        candidateFamily: profile.gateway.protocolFamily,
        profileDocument: journal.profileDocument,
        profile,
      },
      identity: journal.identity,
      now: () => journal.createdAt,
    });
  }

  #indexEntry(plan) {
    return Object.freeze({
      profileId: plan.context.profileId,
      profileKey: plan.context.profileKey,
      createdAt: plan.createdAt,
    });
  }

  #singleFlight(operation) {
    if (this.running) throw new Error('custom Profile provisioning is already running');
    this.running = true;
    try { return operation(); }
    finally { this.running = false; }
  }
}

module.exports = { CustomProfileProvisioningRuntime };
