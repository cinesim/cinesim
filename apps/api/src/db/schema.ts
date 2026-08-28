import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  bigint,
  timestamp,
  boolean,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("account_issuer_accountId_uidx").on(table.issuer, table.accountId),
    index("account_userId_idx").on(table.userId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const cloudProject = pgTable(
  "cloud_project",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientProjectId: text("client_project_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("cloud_project_userId_idx").on(table.userId),
    uniqueIndex("cloud_project_userId_clientProjectId_uidx").on(
      table.userId,
      table.clientProjectId,
    ),
  ],
);

export const cloudAsset = pgTable(
  "cloud_asset",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => cloudProject.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientAssetId: text("client_asset_id").notNull(),
    objectKey: text("object_key").notNull().unique(),
    originalName: text("original_name").notNull(),
    mediaKind: text("media_kind").notNull(),
    contentType: text("content_type").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull(),
    reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    state: text("state").notNull(),
    r2Etag: text("r2_etag"),
    trashedAt: timestamp("trashed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index("cloud_asset_userId_idx").on(table.userId),
    index("cloud_asset_projectId_idx").on(table.projectId),
    uniqueIndex("cloud_asset_projectId_clientAssetId_uidx").on(
      table.projectId,
      table.clientAssetId,
    ),
  ],
);

export const cloudUpload = pgTable(
  "cloud_upload",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .unique()
      .references(() => cloudAsset.id, { onDelete: "cascade" }),
    r2UploadId: text("r2_upload_id").notNull(),
    partSize: integer("part_size").notNull(),
    sourceSize: bigint("source_size", { mode: "number" }).notNull(),
    sourceMtimeMs: bigint("source_mtime_ms", { mode: "number" }).notNull(),
    sourceEdgeHash: text("source_edge_hash").notNull(),
    state: text("state").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("cloud_upload_assetId_idx").on(table.assetId)],
);

export const cloudUploadPart = pgTable(
  "cloud_upload_part",
  {
    uploadId: text("upload_id")
      .notNull()
      .references(() => cloudUpload.id, { onDelete: "cascade" }),
    partNumber: integer("part_number").notNull(),
    etag: text("etag").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.uploadId, table.partNumber] })],
);

export const storageEntitlement = pgTable("storage_entitlement", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  storageNamespace: text("storage_namespace").notNull().unique(),
  includedBytes: bigint("included_bytes", { mode: "number" }).notNull(),
  addonBytes: bigint("addon_bytes", { mode: "number" }).notNull().default(0),
  usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
  reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  cloudProjects: many(cloudProject),
  cloudAssets: many(cloudAsset),
}));

export const cloudProjectRelations = relations(cloudProject, ({ one, many }) => ({
  user: one(user, { fields: [cloudProject.userId], references: [user.id] }),
  assets: many(cloudAsset),
}));

export const cloudAssetRelations = relations(cloudAsset, ({ one }) => ({
  user: one(user, { fields: [cloudAsset.userId], references: [user.id] }),
  project: one(cloudProject, {
    fields: [cloudAsset.projectId],
    references: [cloudProject.id],
  }),
  upload: one(cloudUpload),
}));

export const cloudUploadRelations = relations(cloudUpload, ({ one, many }) => ({
  asset: one(cloudAsset, { fields: [cloudUpload.assetId], references: [cloudAsset.id] }),
  parts: many(cloudUploadPart),
}));

export const cloudUploadPartRelations = relations(cloudUploadPart, ({ one }) => ({
  upload: one(cloudUpload, {
    fields: [cloudUploadPart.uploadId],
    references: [cloudUpload.id],
  }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));
