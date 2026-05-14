CREATE TABLE `cleanCloudWebhookEvents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`eventType` varchar(64) NOT NULL,
	`eventId` varchar(128) NOT NULL,
	`payload` json NOT NULL,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`processedAt` timestamp,
	`dispatchError` text,
	CONSTRAINT `cleanCloudWebhookEvents_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_event_type_id` UNIQUE(`eventType`,`eventId`)
);
