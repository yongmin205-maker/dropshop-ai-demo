CREATE TABLE IF NOT EXISTS `dailyBriefings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`briefingDate` varchar(10) NOT NULL,
	`periodStartMs` varchar(20) NOT NULL,
	`periodEndMs` varchar(20) NOT NULL,
	`metrics` json NOT NULL,
	`summaryMarkdown` text NOT NULL,
	`llmModel` varchar(64),
	`promptTokens` int,
	`completionTokens` int,
	`generatedAt` timestamp NOT NULL DEFAULT (now()),
	`deliveredAt` timestamp,
	`errorMessage` text,
	CONSTRAINT `dailyBriefings_id` PRIMARY KEY(`id`),
	CONSTRAINT `dailyBriefings_briefingDate_unique` UNIQUE(`briefingDate`)
);
