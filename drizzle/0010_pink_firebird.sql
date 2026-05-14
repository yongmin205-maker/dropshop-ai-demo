CREATE TABLE `posCustomers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source` enum('cleancloud','dropshop_pos') NOT NULL,
	`externalId` varchar(64) NOT NULL,
	`name` varchar(256),
	`phoneE164` varchar(32),
	`phoneRaw` varchar(64),
	`email` varchar(320),
	`address` text,
	`notes` text,
	`marketingOptIn` int NOT NULL DEFAULT 0,
	`loyaltyPoints` int NOT NULL DEFAULT 0,
	`creditCents` int NOT NULL DEFAULT 0,
	`rawPayload` json,
	`syncedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `posCustomers_id` PRIMARY KEY(`id`),
	CONSTRAINT `posCustomers_source_external_unique` UNIQUE(`source`,`externalId`)
);
--> statement-breakpoint
CREATE TABLE `posExternalRefs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`entityType` enum('customer','order','payment','product') NOT NULL,
	`source` enum('cleancloud','dropshop_pos') NOT NULL,
	`externalId` varchar(64) NOT NULL,
	`internalId` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `posExternalRefs_id` PRIMARY KEY(`id`),
	CONSTRAINT `posExternalRefs_type_source_external_unique` UNIQUE(`entityType`,`source`,`externalId`)
);
--> statement-breakpoint
CREATE TABLE `posOrders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source` enum('cleancloud','dropshop_pos') NOT NULL,
	`externalId` varchar(64) NOT NULL,
	`customerExternalId` varchar(64),
	`status` enum('received','cleaning','ready','out_for_delivery','picked_up','completed','cancelled','unknown') NOT NULL,
	`sourceStatusRaw` varchar(32),
	`finalTotalCents` int NOT NULL DEFAULT 0,
	`paid` int NOT NULL DEFAULT 0,
	`completed` int NOT NULL DEFAULT 0,
	`express` int NOT NULL DEFAULT 0,
	`placedAt` timestamp,
	`pickupAt` timestamp,
	`deliveryAt` timestamp,
	`notes` text,
	`itemsSummary` json,
	`rawPayload` json,
	`syncedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `posOrders_id` PRIMARY KEY(`id`),
	CONSTRAINT `posOrders_source_external_unique` UNIQUE(`source`,`externalId`)
);
--> statement-breakpoint
CREATE TABLE `posPayments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source` enum('cleancloud','dropshop_pos') NOT NULL,
	`externalId` varchar(64) NOT NULL,
	`orderExternalId` varchar(64),
	`customerExternalId` varchar(64),
	`amountCents` int NOT NULL,
	`type` enum('cash','card','credit','stripe','square','loyalty_points','other','unknown') NOT NULL DEFAULT 'unknown',
	`sourceTypeRaw` varchar(32),
	`refunded` int NOT NULL DEFAULT 0,
	`paidAt` timestamp,
	`rawPayload` json,
	`syncedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `posPayments_id` PRIMARY KEY(`id`),
	CONSTRAINT `posPayments_source_external_unique` UNIQUE(`source`,`externalId`)
);
--> statement-breakpoint
CREATE TABLE `posProductChanges` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source` enum('cleancloud','dropshop_pos') NOT NULL,
	`externalId` varchar(64) NOT NULL,
	`kind` enum('added','removed','price_changed') NOT NULL,
	`oldPriceCents` int,
	`newPriceCents` int,
	`productName` varchar(256),
	`syncLogId` int NOT NULL,
	`detectedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `posProductChanges_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `posProducts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source` enum('cleancloud','dropshop_pos') NOT NULL,
	`externalId` varchar(64) NOT NULL,
	`priceListExternalId` varchar(64),
	`name` varchar(256) NOT NULL,
	`category` varchar(128),
	`priceCents` int NOT NULL DEFAULT 0,
	`parentExternalId` varchar(64),
	`rawPayload` json,
	`syncedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `posProducts_id` PRIMARY KEY(`id`),
	CONSTRAINT `posProducts_source_external_unique` UNIQUE(`source`,`externalId`)
);
--> statement-breakpoint
CREATE TABLE `posSyncLog` (
	`id` int AUTO_INCREMENT NOT NULL,
	`source` enum('cleancloud','dropshop_pos') NOT NULL,
	`trigger` enum('daily_pull_03am_et','manual','backfill','webhook') NOT NULL,
	`endpoint` varchar(64) NOT NULL,
	`windowFrom` timestamp,
	`windowTo` timestamp,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`finishedAt` timestamp,
	`rowsFetched` int NOT NULL DEFAULT 0,
	`rowsUpserted` int NOT NULL DEFAULT 0,
	`rowsFailed` int NOT NULL DEFAULT 0,
	`error` text,
	CONSTRAINT `posSyncLog_id` PRIMARY KEY(`id`)
);
