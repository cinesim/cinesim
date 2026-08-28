CREATE TABLE "cloud_asset" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"client_asset_id" text NOT NULL,
	"object_key" text NOT NULL,
	"original_name" text NOT NULL,
	"media_kind" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" bigint NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"checksum_sha256" text NOT NULL,
	"state" text NOT NULL,
	"r2_etag" text,
	"trashed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_asset_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "cloud_project" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_project_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_upload" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"r2_upload_id" text NOT NULL,
	"part_size" integer NOT NULL,
	"source_size" bigint NOT NULL,
	"source_mtime_ms" bigint NOT NULL,
	"source_edge_hash" text NOT NULL,
	"state" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_upload_asset_id_unique" UNIQUE("asset_id")
);
--> statement-breakpoint
CREATE TABLE "cloud_upload_part" (
	"upload_id" text NOT NULL,
	"part_number" integer NOT NULL,
	"etag" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cloud_upload_part_upload_id_part_number_pk" PRIMARY KEY("upload_id","part_number")
);
--> statement-breakpoint
CREATE TABLE "storage_entitlement" (
	"user_id" text PRIMARY KEY NOT NULL,
	"storage_namespace" text NOT NULL,
	"included_bytes" bigint NOT NULL,
	"addon_bytes" bigint DEFAULT 0 NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "storage_entitlement_storage_namespace_unique" UNIQUE("storage_namespace")
);
--> statement-breakpoint
ALTER TABLE "cloud_asset" ADD CONSTRAINT "cloud_asset_project_id_cloud_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."cloud_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_asset" ADD CONSTRAINT "cloud_asset_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_project" ADD CONSTRAINT "cloud_project_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_upload" ADD CONSTRAINT "cloud_upload_asset_id_cloud_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."cloud_asset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cloud_upload_part" ADD CONSTRAINT "cloud_upload_part_upload_id_cloud_upload_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."cloud_upload"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_entitlement" ADD CONSTRAINT "storage_entitlement_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cloud_asset_userId_idx" ON "cloud_asset" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cloud_asset_projectId_idx" ON "cloud_asset" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_asset_projectId_clientAssetId_uidx" ON "cloud_asset" USING btree ("project_id","client_asset_id");--> statement-breakpoint
CREATE INDEX "cloud_project_userId_idx" ON "cloud_project" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_project_userId_clientProjectId_uidx" ON "cloud_project" USING btree ("user_id","client_project_id");--> statement-breakpoint
CREATE INDEX "cloud_upload_assetId_idx" ON "cloud_upload" USING btree ("asset_id");
