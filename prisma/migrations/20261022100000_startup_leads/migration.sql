-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'SAVED', 'CONTACTED', 'DISMISSED');

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "website" TEXT NOT NULL DEFAULT '',
    "summary" TEXT NOT NULL DEFAULT '',
    "details" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "remote" BOOLEAN,
    "stage" TEXT NOT NULL DEFAULT '',
    "teamSize" INTEGER,
    "tags" JSONB NOT NULL,
    "roles" JSONB NOT NULL,
    "emails" JSONB NOT NULL,
    "links" JSONB NOT NULL,
    "postedAt" TIMESTAMP(3),
    "score" INTEGER NOT NULL DEFAULT 0,
    "reasons" JSONB NOT NULL,
    "scoredWith" TEXT NOT NULL DEFAULT '',
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "emailsCheckedAt" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Lead_source_externalId_key" ON "Lead"("source", "externalId");

-- CreateIndex
CREATE INDEX "Lead_status_score_idx" ON "Lead"("status", "score");
