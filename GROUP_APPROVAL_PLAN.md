# Plan: goedkeuring van nieuwe groepsleden (require_approval)

> **Status 2026-07-18: geïmplementeerd én gedeployd** (backend + frontend,
> migratie 023 lokaal en op Hetzner gedraaid, webbuild live op
> goldfishstudy.app). Nog open: E2E-test met twee devices in de app.

## Doel

De groepseigenaar kan per groep een toggle aanzetten: **nieuwe leden goedkeuren**.
Staat die aan, dan wordt iedereen die via code + wachtwoord joint eerst
`pending`; de owner keurt goed (→ `active`) of wijst af (→ rij weg). Staat hij
uit (default), dan werkt joinen zoals nu: direct `active`.

Bewuste keuzes:

- **Invites blijven buiten de goedkeuring.** Een invite is al een expliciete
  uitnodiging door een actief lid (alleen eigen contacten); accepteren blijft
  direct `active`. De toggle gaat alleen over de anonieme route code+wachtwoord.
- **Pending leden zien het volledige group-object** (net als `invited` nu).
  Per-viewer strippen zou het "één canoniek object"-ontwerp en de
  WS-broadcasts breken; wie code+ww heeft kon bij toggle-uit toch al binnen.
  Pending geeft verder nérgens rechten: `activeMembership()` filtert al op
  `status = 'active'`, dus decks toevoegen / dashboard-add / inviten is
  automatisch geblokkeerd.
- **Toggle uitzetten activeert alle pending leden.** De owner zegt daarmee
  "iedereen met code+ww mag erin", en pending leden hebben code+ww al bewezen.
  (Anders zouden ze vastzitten: opnieuw joinen botst op de UNIQUE.)
- **Afwijzen = bestaande kick-endpoint.** `DELETE /groups/:id/members/:user_id`
  verwijdert elke member-rij (owner-pad) en stuurt al `group_removed` naar de
  betrokkene. Zelf een aanvraag intrekken werkt via hetzelfde endpoint
  (isSelf-pad). Geen nieuwe delete-routes nodig.

---

## Backend

### 1. Migratie `023_group_join_approval.sql` (+ `_down`)

```sql
ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS require_approval boolean NOT NULL DEFAULT false;

ALTER TABLE group_members DROP CONSTRAINT group_members_status_check;
ALTER TABLE group_members ADD CONSTRAINT group_members_status_check
  CHECK (status IN ('invited', 'active', 'pending'));
```

Down: `DELETE FROM group_members WHERE status = 'pending'`, constraint
terugzetten naar ('invited','active'), kolom droppen. Uitvoeren volgens de
werkwijze in memory (`sudo -u postgres psql`, tabellen owned by postgres).

### 2. `src/routes/groups.js`

**`fetchGroupObjects`** — `require_approval` mee-SELECTen uit `groups` zodat
het in elk group-object zit (client leest de toggle daaruit).

**`POST /groups` (create)** — optioneel `require_approval` (boolean, default
false) accepteren en mee-inserten. Validatie via `invalidBoolean`.

**`PUT /groups/:id`** — `require_approval` als derde optioneel veld naast
name/description (zelfde COALESCE-patroon). Bij het zetten naar `false` in
dezelfde statement/transactie alle pending leden activeren:

```sql
UPDATE group_members SET status = 'active', updated_at = NOW()
WHERE group_id = $1 AND status = 'pending';
```

(alleen als de toggle van true→false gaat). Daarna zoals nu `group_updated`
broadcasten — geactiveerde leden zien hun status omslaan.

**`POST /groups/join`** — na de wachtwoord-verify ook `require_approval`
selecteren. Insert-status wordt `require_approval ? 'pending' : 'active'`.
Upsert-gedrag:

- bestaande `invited`-rij → wordt `active` zoals nu (invite verslaat toggle:
  er lag al een uitnodiging klaar);
- bestaande `pending`-rij → **409 `{ error: "approval_pending" }`** (aparte
  code zodat de client "aanvraag loopt al" kan tonen i.p.v. "al lid");
- bestaande `active`-rij → 409 `already_member` zoals nu.

Response bij pending: gewoon 201 + group-object; de client leidt "pending" af
uit zijn eigen member-rij. Broadcast `group_updated` naar de hele groep
(`broadcastGroup` selecteert alle statussen, dus de aanvrager en de owner
krijgen hem allebei).

**Nieuw: `POST /groups/:id/members/:user_id/approve`** (owner):

```sql
UPDATE group_members m SET status = 'active', updated_at = NOW()
FROM groups g
WHERE m.group_id = $1 AND m.user_id = $2 AND m.status = 'pending'
  AND g.id = m.group_id AND g.owner_id = $3 AND g.deleted_at IS NULL
RETURNING m.id
```

0 rijen → 404. Daarna `group_updated` broadcasten; response = group-object.
(Zelfde vorm als `invites/accept`.)

**Check overige routes** — geen wijzigingen nodig:

- `activeMembership` filtert op `active` → pending heeft nergens rechten;
- invite naar een pending user → `ON CONFLICT DO NOTHING` → 409
  `already_exists` (prima);
- kick/leave verwijdert pending-rijen al en `revokeShares` vindt niets
  (pending had geen shares);
- `DELETE /groups/:id` (opheffen) ruimt pending-rijen mee op.

### 3. WS

Geen nieuwe event-types: `group_updated` (vol object) en `group_removed`
dekken alles. Eventueel later een pushnotificatie voor de owner — buiten scope.

### 4. Documentatie

`BACKEND_API.md` bijwerken in **beide** repos (backend + frontend, zie
memory-regel): toggle-veld, status `pending`, approve-endpoint, error-code
`approval_pending`, toggle-uit-activeert-pending-gedrag.

---

## Frontend (Flutter, `/mnt/c/programming/goldfish/goldfish_v1`)

### 1. Model (`lib/models/group.dart`)

- `GroupMember`: status kan nu ook `'pending'` → getter `bool get isPending`.
- `Group`: nieuw veld `@HiveField(8, defaultValue: false) final bool
  requireApproval;` + parsen uit `require_approval`.
- `activeMembers` blijft filteren op `!isInvited` → ook `!isPending` maken
  (of: `status == 'active'`), en een getter `pendingMembers` toevoegen
  (gesorteerd op naam) voor de owner-weergave.
- `build_runner` draaien voor `group.g.dart`.

### 2. Remote (`lib/data/remote/group_remote.dart`)

- `create(...)` en `update(...)`: optionele `bool? requireApproval` →
  `'require_approval'` in de body.
- Nieuw: `approveMember(String id, String userId)` → `POST
  /groups/$id/members/$userId/approve`.
- Afwijzen/intrekken hergebruikt `removeMember`.

### 3. Provider (`lib/providers/group_provider.dart`)

- `GroupActionResult`: nieuw geval `approvalPending` (join → 409 met body
  `approval_pending`; daarvoor moet `join()` bij 409 de body parsen om
  `already_member` en `approval_pending` uit elkaar te houden).
- `joined`-getter: pending uitsluiten (`status == 'active'` i.p.v. alleen
  `!isInvited`). Nieuwe getter `pendingRequests` (groepen waar ík pending
  ben) voor de "aanvraag loopt"-weergave.
- Badge: `pendingCount` uitbreiden tot invites **+ het aantal pending leden
  in groepen waarvan ik owner ben** (de owner moet zien dat er iets te
  keuren valt).
- Nieuw: `approveMember(id, userId)` (200 → `_absorb`), `setRequireApproval(
  id, bool)` via `rename`/`update`-flow (200 → `_absorb`).
- `join()`: bij 201 óók checken of mijn member-status pending is → result
  `ok` laten, maar de UI leest de status uit het teruggegeven object (zie
  UI-punt hieronder); simpelst: aparte result `okPending` retourneren zodat
  de join-dialog direct het juiste bericht toont.

### 4. UI

- **Create-dialog + groepsinstellingen** (`group_dialogs.dart`,
  `group_detail_panel.dart`): SwitchListTile "Nieuwe leden goedkeuren"
  (alleen owner). Bij uitzetten een korte confirm ("alle openstaande
  aanvragen worden geaccepteerd").
- **Join-flow** (`group_dialogs.dart`): result `okPending` → snackbar/dialoog
  "Aanvraag verstuurd — de eigenaar moet je nog goedkeuren";
  `approvalPending` → "Je aanvraag loopt al".
- **Groups-screen** (`groups_screen.dart`): pending-aanvragen van mijzelf
  tonen in de lijst met een chip "wacht op goedkeuring" (zoals invites een
  eigen sectie hebben); tik → optie "aanvraag intrekken" (leave-pad).
- **Group-detail (ownerkant)** (`group_detail_panel.dart`): sectie
  "Aanvragen" boven de ledenlijst met per pending lid ✓ (approve) en ✕
  (reject = removeMember). Badge-telling loopt via de provider.
- **Member-detail** (`member_detail_panel.dart`): voor een pending lid
  approve/afwijs-knoppen i.p.v. de permissietoggle.
- **Pending-viewer zelf**: in `group_detail_panel.dart` voor een pending
  kijker alleen naam/omschrijving + "wacht op goedkeuring" tonen en de
  actieknoppen (deck toevoegen, inviten, dashboard-add) verbergen — de
  server weigert ze toch, maar de UI moet ze niet aanbieden.

### 5. Strings

Nieuwe keys in `app_strings.dart` + alle zes taalbestanden (nl, en, de, fr,
es, xx): toggle-label + uitleg, "aanvraag verstuurd", "aanvraag loopt al",
"wacht op goedkeuring", sectiekop "Aanvragen", approve/afwijs, confirm bij
toggle-uit.

### 6. WS-client

Geen wijziging: `realtime_sync_service.dart` routeert `group_updated` /
`group_removed` al naar `applyServerEvents`, en die upsert het volle object.

---

## Volgorde & test

1. Migratie 023 lokaal draaien.
2. Backend: create/PUT-toggle → join wordt pending → approve/reject →
   toggle-uit activeert pending. Testen met twee accounts (curl of app).
3. BACKEND_API.md ×2 bijwerken.
4. Frontend: model + build_runner → remote/provider → UI → strings.
5. E2E met twee devices: badge bij owner, realtime status-omslag bij de
   aanvrager, intrekken, afwijzen, toggle-uit.
6. Deploy volgens `project_remote_deploy.md` (eerst volledig lezen) +
   migratie op Hetzner.
