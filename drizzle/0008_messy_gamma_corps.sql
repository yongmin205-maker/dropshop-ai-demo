ALTER TABLE `messages` MODIFY COLUMN `mode` enum('simulator','live','shadow') NOT NULL DEFAULT 'simulator';--> statement-breakpoint
ALTER TABLE `conversations` ADD `shadowMode` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `shadowSource` varchar(32);