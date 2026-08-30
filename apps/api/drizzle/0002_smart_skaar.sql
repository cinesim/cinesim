CREATE TABLE "transcription_request" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"network_key" text NOT NULL,
	"period" text NOT NULL,
	"state" text NOT NULL,
	"reserved_milliseconds" bigint NOT NULL,
	"charged_milliseconds" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "transcription_usage" (
	"user_id" text NOT NULL,
	"period" text NOT NULL,
	"charged_milliseconds" bigint DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transcription_usage_user_id_period_pk" PRIMARY KEY("user_id","period")
);
--> statement-breakpoint
ALTER TABLE "transcription_request" ADD CONSTRAINT "transcription_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_usage" ADD CONSTRAINT "transcription_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcription_request_user_created_idx" ON "transcription_request" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "transcription_request_network_created_idx" ON "transcription_request" USING btree ("network_key","created_at");--> statement-breakpoint
CREATE INDEX "transcription_request_active_idx" ON "transcription_request" USING btree ("state","expires_at");