
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;
SET @MYSQLDUMP_TEMP_LOG_BIN = @@SESSION.SQL_LOG_BIN;
SET @@SESSION.SQL_LOG_BIN= 0;
SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '09ec7bf0-6aea-11ef-9d87-6a715c8e2063:1-672217,
1d13d0b5-6a38-11ef-8e1e-5ad390b708ce:1-32,
2782d44e-8964-11f0-9790-46e6c3616cc3:1-15424531,
4632b8b1-8c55-11ef-a605-3686a038c92a:1-4751255,
50464d10-152d-11f1-a054-de1fa618dbf5:1-8426530,
727f3e72-f257-11f0-984f-1e4319312253:1-15914169,
792670dc-6acb-11ef-b0d7-4eaa2ab05774:1-2660,
a064e71e-6ac8-11ef-a0a1-7a0f4e47e568:1-17,
aee58f14-6ac6-11ef-927d-e2958e58c9c9:1-15,
b99b7dda-6a39-11ef-95cf-8eda1ab3cac0:1-217,
b9fdcead-6aa8-11ef-9d21-da87ef8aad42:1-6841,
cf2b9076-25ad-11f1-a77d-aa6da6ecc36c:1-39887535,
cffb1ca8-0f9e-11f0-864e-5a48d51e8bf6:1-4719578,
e41663ee-ec23-11ef-9c2e-2e8aa021374b:1-18658692';
DROP TABLE IF EXISTS `actions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `actions` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `skill` enum('hard_skill','soft_skill','workflow') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `user_id` bigint unsigned DEFAULT NULL,
  `team_id` bigint unsigned DEFAULT NULL,
  `department_id` bigint DEFAULT NULL,
  `production_step` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `system_task` enum('collect_payment','send_follow_up_email','missing_invoice','attention_needed','validate_the_lead','packing_slip_missing','proofing_delay','approval_delay','customer_credit_limit_exceeded','late_project','late_pickup','convert_to_invoice','onboard_the_lead','resend_email','clarify_due_date') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `actions_name_index` (`name`),
  KEY `actions_user_id_index` (`user_id`)
) ENGINE=InnoDB AUTO_INCREMENT=75 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `areas`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `areas` (
  `id` int NOT NULL AUTO_INCREMENT,
  `page_id` int NOT NULL,
  `type` enum('text','image') DEFAULT NULL,
  `shape` enum('circle','rectangle') DEFAULT NULL,
  `placeholder` varchar(100) DEFAULT NULL,
  `font` varchar(100) DEFAULT NULL,
  `font_size` float DEFAULT NULL,
  `alignment` enum('left','right','center') DEFAULT NULL,
  `width` float DEFAULT NULL,
  `height` float DEFAULT NULL,
  `top` float DEFAULT NULL,
  `left` float DEFAULT NULL,
  `text_color` varchar(100) CHARACTER SET latin1 COLLATE latin1_spanish_ci DEFAULT NULL,
  `color_editable` tinyint DEFAULT NULL,
  `order` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `page_id` (`page_id`),
  CONSTRAINT `areas_ibfk_1` FOREIGN KEY (`page_id`) REFERENCES `pages` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=165 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `articles`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `articles` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(200) NOT NULL,
  `text` longtext NOT NULL,
  `active_from` datetime DEFAULT NULL,
  `active_to` datetime DEFAULT NULL,
  `category` enum('product_feature','company_updates','events','case_studies','news') DEFAULT NULL,
  `tags` text,
  `thumbnail` text,
  `url` varchar(400) DEFAULT NULL,
  `image_name` text,
  `alt` text,
  `meta_description` longtext,
  `created_at` datetime DEFAULT NULL,
  `created_by` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=161 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `auth_assignment`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `auth_assignment` (
  `item_name` varchar(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `user_id` varchar(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `created_at` int DEFAULT NULL,
  PRIMARY KEY (`item_name`,`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `auth_item`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `auth_item` (
  `name` varchar(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `type` smallint NOT NULL,
  `description` text CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci,
  `rule_name` varchar(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `data` blob,
  `created_at` int DEFAULT NULL,
  `updated_at` int DEFAULT NULL,
  PRIMARY KEY (`name`),
  KEY `rule_name` (`rule_name`),
  KEY `idx-auth_item-type` (`type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `auth_item_child`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `auth_item_child` (
  `parent` varchar(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `child` varchar(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  PRIMARY KEY (`parent`,`child`),
  KEY `child` (`child`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `auth_rule`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `auth_rule` (
  `name` varchar(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `data` blob,
  `created_at` int DEFAULT NULL,
  `updated_at` int DEFAULT NULL,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `bot_work_scenarios`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `bot_work_scenarios` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL,
  `type` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL,
  `remind_after` int NOT NULL,
  `question` varchar(255) NOT NULL,
  `options` json NOT NULL,
  `notified_to_type` enum('persons','group','all') NOT NULL DEFAULT 'all',
  `notified_to` json DEFAULT NULL,
  `conjunction` enum('and','or','no') DEFAULT NULL,
  `conditions` json DEFAULT NULL,
  `on_action` json NOT NULL,
  `can_add_comment` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `bot_works`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `bot_works` (
  `id` int NOT NULL AUTO_INCREMENT,
  `client_id` int NOT NULL,
  `created_at` datetime NOT NULL,
  `invoice_id` int NOT NULL,
  `project_id` int NOT NULL,
  `work_notify_after` datetime NOT NULL,
  `notified` tinyint(1) NOT NULL DEFAULT '0',
  `answered` tinyint(1) NOT NULL DEFAULT '0',
  `user_id` int NOT NULL,
  `work_scenario_id` int NOT NULL,
  `can_add_comment` tinyint(1) NOT NULL DEFAULT '0',
  `work_answer_text` varchar(255) DEFAULT NULL,
  `work_answer_score` int DEFAULT NULL,
  `work_answer_comment` varchar(500) DEFAULT NULL,
  `work_question` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL,
  `work_options` json NOT NULL,
  `work_type` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL,
  `answered_date` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=65360 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `boxes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `boxes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `image_path` varchar(100) DEFAULT NULL,
  `width` decimal(10,2) DEFAULT NULL,
  `height` decimal(10,2) DEFAULT NULL,
  `length` decimal(10,2) DEFAULT NULL,
  `description` varchar(10000) DEFAULT NULL,
  `volume` decimal(10,2) DEFAULT NULL,
  `code` varchar(255) DEFAULT NULL,
  `weight` decimal(10,2) DEFAULT NULL,
  `lb` decimal(10,2) DEFAULT NULL,
  `type` enum('box','tube','plastic','envelope') DEFAULT NULL,
  `cost` decimal(10,2) DEFAULT NULL,
  `team_ids` json DEFAULT NULL,
  `geo_type_id` int DEFAULT NULL,
  `geo_sub_type_id` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=94 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `business_categories`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `business_categories` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=49 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `business_category_new`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `business_category_new` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `parent_id` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `parent_id` (`parent_id`)
) ENGINE=InnoDB AUTO_INCREMENT=622 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `cache`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `cache` (
  `key` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `expiration` int NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `cache_locks`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `cache_locks` (
  `key` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `owner` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `expiration` int NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `calls`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `calls` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `thread_id` int DEFAULT NULL,
  `call_id` varchar(200) DEFAULT NULL,
  `direction` enum('outbound','inbound') NOT NULL DEFAULT 'inbound',
  `is_internal` tinyint NOT NULL DEFAULT '0',
  `from_phone` varchar(255) DEFAULT NULL,
  `from_email` varchar(100) DEFAULT NULL,
  `from_customer_id` int DEFAULT NULL,
  `from_manager_id` int DEFAULT NULL,
  `to_phone` varchar(100) DEFAULT NULL,
  `to_email` varchar(255) DEFAULT NULL,
  `to_customer_id` int DEFAULT NULL,
  `to_manager_id` int DEFAULT NULL,
  `answered_by_phone` varchar(200) DEFAULT NULL,
  `answered_by_manager_id` int DEFAULT NULL,
  `answered_by_customer_id` int DEFAULT NULL,
  `entry_point_target_phone` varchar(100) DEFAULT NULL,
  `entry_point_manager_id` int DEFAULT NULL,
  `duration` decimal(10,3) DEFAULT NULL,
  `project_id` int DEFAULT NULL,
  `status` enum('missed','answered','voicemail_uploaded','ringing','transferred') DEFAULT NULL,
  `voicemail_recording_id` varchar(200) DEFAULT NULL,
  `voicemail_recording_url` varchar(200) DEFAULT NULL,
  `call_recording_ids` json DEFAULT NULL,
  `call_recording_urls` json DEFAULT NULL,
  `transcription_text` longtext,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `previousCallsCount` int DEFAULT NULL,
  `notes` varchar(10000) DEFAULT NULL,
  `notes_updated_by` int DEFAULT NULL,
  `label` enum('missed','resolved_email','resolved_in_person','resolved_other','called_back','group_missed','resolved_by_2nd_call') DEFAULT NULL,
  `label_updated_by` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=67536 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `calls_events`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `calls_events` (
  `id` int NOT NULL AUTO_INCREMENT,
  `call_id` int DEFAULT NULL,
  `master_call_id` varchar(100) DEFAULT NULL,
  `original_call_id` varchar(100) DEFAULT NULL,
  `entry_point_call_id` varchar(100) DEFAULT NULL,
  `operator_call_id` varchar(100) DEFAULT NULL,
  `from_phone` varchar(100) DEFAULT NULL,
  `from_customer_id` int DEFAULT NULL,
  `from_manager_id` int DEFAULT NULL,
  `to_customer_id` int DEFAULT NULL,
  `to_manager_id` int DEFAULT NULL,
  `to_phone` varchar(100) DEFAULT NULL,
  `entry_point_target_phone` varchar(100) DEFAULT NULL,
  `status` varchar(100) NOT NULL,
  `direction` enum('outbound','inbound') DEFAULT NULL,
  `duration` int DEFAULT NULL,
  `is_transferred` tinyint(1) DEFAULT '0',
  `voicemail_recording_id` varchar(200) DEFAULT NULL,
  `call_recording_ids` json DEFAULT NULL,
  `call_recording_urls` json DEFAULT NULL,
  `transcription_text` longtext,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=488665 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `calls_thread`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `calls_thread` (
  `id` int NOT NULL AUTO_INCREMENT,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=52378 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `cancellation_reason`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `cancellation_reason` (
  `id` int NOT NULL AUTO_INCREMENT,
  `project_id` int NOT NULL,
  `estimate_id` int DEFAULT NULL,
  `reason` enum('wrong_order','not_interested','duplicate','turnaround','price','other') NOT NULL,
  `note` varchar(5000) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `created_by` int NOT NULL DEFAULT '-1',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=6352 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `carts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `carts` (
  `uuid` char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` int unsigned DEFAULT NULL,
  `items` json NOT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL,
  `invoice_details` json DEFAULT NULL,
  PRIMARY KEY (`uuid`),
  KEY `carts_user_id_index` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `categories`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `categories` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `parent_id` bigint unsigned DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL,
  `icon_url` varchar(2048) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `shelf_room_id` bigint unsigned DEFAULT NULL COMMENT 'room id for shelf category',
  `required` tinyint(1) NOT NULL DEFAULT '0',
  `color_hex` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `categories_name_type_index` (`name`,`type`),
  KEY `categories_name_index` (`name`),
  KEY `categories_parent_id_index` (`parent_id`),
  KEY `categories_shelf_room_id_index` (`shelf_room_id`)
) ENGINE=InnoDB AUTO_INCREMENT=200 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `commision`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `commision` (
  `id` int NOT NULL AUTO_INCREMENT,
  `manager_id` int unsigned NOT NULL,
  `invoice_id` int unsigned NOT NULL,
  `percent` int unsigned NOT NULL,
  `amount` decimal(8,2) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `commission_payments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `commission_payments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `date` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `manager_id` int NOT NULL,
  `amount` decimal(12,6) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=533 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `cron_queue`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `cron_queue` (
  `id` int NOT NULL AUTO_INCREMENT,
  `estimate_id` int DEFAULT NULL,
  `customer_id` int DEFAULT NULL,
  `type` enum('create_drive_folder','ai_validate_customer','create_task_for_onboarding','create_task_for_lead_validation','move_client_uploaded_files_to_customer_folder','move_reorder_files_to_customer_folder','move_files_to_customer_folder') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `status` enum('pending','done','processing') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL DEFAULT 'pending',
  `details` json DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `status` (`status`),
  KEY `estimate_id` (`estimate_id`)
) ENGINE=InnoDB AUTO_INCREMENT=43364 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `customer`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customer` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(200) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `last_name` varchar(200) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `email` varchar(200) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `password` varchar(200) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `country_code` int NOT NULL DEFAULT '1',
  `country_iso` varchar(10) NOT NULL DEFAULT 'US',
  `phone_mask` varchar(100) NOT NULL DEFAULT '(000) 000-0000',
  `phone` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `extension` varchar(100) DEFAULT NULL,
  `registered` tinyint(1) NOT NULL DEFAULT '1',
  `active` tinyint(1) NOT NULL DEFAULT '0',
  `due_date_id` int DEFAULT NULL,
  `company_name` varchar(200) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `company_number` varchar(200) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `company_address` varchar(200) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `company_phone` varchar(15) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `company_email` varchar(200) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `reseller` tinyint(1) NOT NULL DEFAULT '0',
  `reseller_number` varchar(100) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `manager_id` int DEFAULT '0',
  `drop_box_path` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `drop_share_link` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `created` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `calculator_fix_percent` int DEFAULT '0',
  `calculator_simple_percent` int DEFAULT '0',
  `calculator_square_percent` int DEFAULT '0',
  `calculator_sticker_percent` int DEFAULT '0',
  `calculator_catalog_percent` int DEFAULT '0',
  `company_tax` tinyint NOT NULL DEFAULT '0',
  `company_postcode` varchar(100) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `customer_commission` decimal(8,2) DEFAULT NULL,
  `note` text CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci,
  `wholesaler` tinyint(1) DEFAULT NULL,
  `discount_options` text CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci,
  `discount_option_id` int DEFAULT NULL,
  `payment_terms` enum('NET_15','NET_30','NET_45','NET_60','PAY_ON_COMPLETE','NOW','PAY_ON_APPROVAL') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL DEFAULT 'NOW',
  `payment_notes` varchar(500) DEFAULT NULL,
  `credit_limit` int DEFAULT NULL,
  `store_credit` float NOT NULL DEFAULT '0',
  `signupper_id` int DEFAULT NULL,
  `signupper_commission` int DEFAULT NULL,
  `refered_by` enum('pinterest','instagram','facebook','other','linkedin','youtube','googleads','merchantcenter','emailmarketing','google','personalreferral','yelp','reddit','trade_show_expo','chat_gpt','axiom_referral') DEFAULT NULL,
  `company_business_category_id` int DEFAULT NULL,
  `company_new_business_category_id` int DEFAULT NULL,
  `company_custom_business_category` varchar(100) DEFAULT NULL,
  `stripe_id` varchar(255) DEFAULT NULL,
  `pay_partial` tinyint(1) NOT NULL DEFAULT '0',
  `title` varchar(255) DEFAULT NULL,
  `custom_fields` json DEFAULT NULL,
  `google_drive_root_folder_name` varchar(100) NOT NULL DEFAULT 'AxiomPrintDrive',
  `google_drive_path` varchar(255) DEFAULT NULL,
  `google_drive_folder_name` varchar(255) DEFAULT NULL,
  `for_invoice` tinyint(1) NOT NULL DEFAULT '1',
  `for_proof` tinyint(1) NOT NULL DEFAULT '1',
  `for_handling` tinyint(1) NOT NULL DEFAULT '1',
  `preferred_method_of_communication` enum('email','text','phone','face_to_face') DEFAULT NULL,
  `created_from_website` tinyint(1) NOT NULL DEFAULT '0',
  `personal_account` tinyint(1) NOT NULL DEFAULT '0',
  `referred_by_client_id` int DEFAULT NULL,
  `referred_by_manager_id` int DEFAULT NULL,
  `verified` tinyint(1) NOT NULL DEFAULT '0',
  `verification_score` int DEFAULT NULL,
  `ach_enabled` tinyint(1) NOT NULL DEFAULT '0',
  `default_handling_method` enum('pickup','shipping','tbd') NOT NULL DEFAULT 'pickup',
  `status` enum('active','inactive') NOT NULL DEFAULT 'active',
  PRIMARY KEY (`id`),
  KEY `teammember` (`manager_id`),
  KEY `id` (`id`),
  KEY `phone` (`phone`),
  KEY `company_phone` (`company_phone`)
) ENGINE=InnoDB AUTO_INCREMENT=35687 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `customer_logs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customer_logs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int DEFAULT NULL,
  `client_id` int DEFAULT NULL,
  `event_type` enum('customer_created','customer_updated','customer_welcome_form_created','customer_referred_by_client_updated','customer_notes_added') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `event` text CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci,
  `event_text` varchar(5000) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=80018 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `customer_phones`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customer_phones` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int NOT NULL,
  `phone` varchar(20) NOT NULL,
  `extension` varchar(100) DEFAULT NULL,
  `phone_mask` varchar(20) NOT NULL,
  `country_iso` varchar(10) NOT NULL,
  `country_code` int NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=287 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `customer_welcome_forms`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customer_welcome_forms` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int NOT NULL,
  `created_by_manager_id` int DEFAULT NULL,
  `onboarding_type` enum('email','phone_call','loom_video','google_meeting','in_person_meeting','in_person_meeting_plus_tour','expo_event') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `notes` varchar(2000) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `linkedin_research` tinyint(1) NOT NULL DEFAULT '0',
  `linkedin_url` varchar(200) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `website_review` tinyint(1) NOT NULL DEFAULT '0',
  `website_url` varchar(200) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `engagement_on_onboarding` int NOT NULL,
  `additional_client_insights_notes` varchar(2000) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `customer_initial_satisfaction` int NOT NULL,
  `estimated_order_value` int DEFAULT NULL,
  `how_did_they_hear_about_us` varchar(2000) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2741 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `customerusers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customerusers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `customer_id` int DEFAULT NULL,
  `name` varchar(255) DEFAULT NULL,
  `last_name` varchar(255) DEFAULT NULL,
  `country_code` int NOT NULL DEFAULT '1',
  `country_iso` varchar(10) NOT NULL DEFAULT 'US',
  `phone_mask` varchar(100) NOT NULL DEFAULT '(000) 000-0000',
  `phone` varchar(20) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `primary_contact` int DEFAULT NULL,
  `company_name` varchar(255) DEFAULT NULL,
  `address` varchar(255) DEFAULT NULL,
  `city` varchar(255) DEFAULT NULL,
  `state` varchar(255) DEFAULT NULL,
  `zip` varchar(255) DEFAULT NULL,
  `unit` varchar(255) DEFAULT NULL,
  `type` enum('address_book','member','both','') NOT NULL DEFAULT 'both',
  `title` varchar(255) DEFAULT NULL,
  `custom_fields` json DEFAULT NULL,
  `for_invoice` tinyint(1) NOT NULL DEFAULT '0',
  `for_proof` tinyint(1) NOT NULL DEFAULT '0',
  `for_handling` tinyint(1) NOT NULL DEFAULT '0',
  `auto_apply_to_projects` tinyint(1) NOT NULL DEFAULT '0',
  `preferred_method_of_communication` enum('email','text','phone','face_to_face') DEFAULT NULL,
  `for_blind_drop` int NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `manageusers` (`customer_id`)
) ENGINE=InnoDB AUTO_INCREMENT=30425 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `department`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `department` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(50) NOT NULL,
  `lead_ids` json NOT NULL,
  `color` varchar(100) NOT NULL DEFAULT '#495ebb',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=12 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `design_templates`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `design_templates` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) DEFAULT NULL,
  `client_id` int DEFAULT NULL,
  `product_ids` json DEFAULT NULL,
  `zoom` int DEFAULT NULL,
  `category` int DEFAULT NULL,
  `thumbnail` text,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=38 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `die_line`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `die_line` (
  `id` int NOT NULL AUTO_INCREMENT,
  `geo_type_id` int DEFAULT NULL,
  `geo_sub_type_id` int DEFAULT NULL,
  `customer_id` int DEFAULT NULL,
  `width` decimal(10,2) DEFAULT NULL,
  `height` decimal(10,2) DEFAULT NULL,
  `dept` decimal(10,2) DEFAULT NULL,
  `up` int DEFAULT NULL,
  `die` varchar(100) DEFAULT NULL,
  `die_prefix` varchar(100) DEFAULT NULL,
  `description` varchar(200) DEFAULT NULL,
  `estimate_id` int DEFAULT NULL,
  `old_die` varchar(100) DEFAULT NULL,
  `product_id` int DEFAULT NULL,
  `punch` varchar(100) DEFAULT NULL,
  `corners` varchar(100) DEFAULT NULL,
  `yield` varchar(100) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `template_file_id` varchar(100) DEFAULT NULL,
  `template_file_name` varchar(100) DEFAULT NULL,
  `template_file_icon_link` varchar(100) DEFAULT NULL,
  `template_file_thumb` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `back_template_file_id` varchar(100) DEFAULT NULL,
  `back_template_file_name` varchar(100) DEFAULT NULL,
  `back_template_file_icon_link` varchar(100) DEFAULT NULL,
  `back_template_file_thumb` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `die_line_file_id` varchar(100) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `die_line_file_name` varchar(100) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `die_line_file_icon_link` varchar(100) DEFAULT NULL,
  `die_line_file_thumb` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `status` enum('in_stock','re_knife','digital') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `use` int DEFAULT NULL,
  `last_date` timestamp NULL DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=359 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `discount_models`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `discount_models` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `icon_url` varchar(100) DEFAULT NULL,
  `value` text CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=34 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `drive_files`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `drive_files` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `parent_id` int DEFAULT NULL,
  `name` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL,
  `drive_path` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL,
  `project_id` int DEFAULT NULL,
  `estimate_id` int DEFAULT NULL,
  `customer_id` int DEFAULT NULL,
  `drive_id` varchar(255) NOT NULL,
  `note` varchar(255) DEFAULT NULL,
  `icon_link` varchar(200) DEFAULT NULL,
  `hash` varchar(255) DEFAULT NULL,
  `thumbnail_link` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=801808 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `email_from_system`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `email_from_system` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `template_id` int DEFAULT NULL,
  `to_email` varchar(255) NOT NULL,
  `from_email` json DEFAULT NULL,
  `cc_email` json DEFAULT NULL,
  `subject` blob,
  `emailstatus` varchar(100) NOT NULL,
  `invoiceid` bigint DEFAULT NULL,
  `project_id` int DEFAULT NULL,
  `estimate_id` int DEFAULT NULL,
  `type` varchar(255) DEFAULT NULL,
  `body_old` longtext CHARACTER SET latin1 COLLATE latin1_swedish_ci,
  `styles` longtext,
  `manager_id` int DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `body` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  PRIMARY KEY (`id`),
  KEY `estimate_id` (`estimate_id`),
  KEY `template_id` (`template_id`),
  KEY `email_from_system_invoiceid_index` (`invoiceid`)
) ENGINE=InnoDB AUTO_INCREMENT=330358 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `email_from_system_status`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `email_from_system_status` (
  `id` int NOT NULL AUTO_INCREMENT,
  `email_id` int NOT NULL,
  `status` enum('open','click','bounce','dropped','delivered','sent') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `created_at` timestamp NOT NULL,
  PRIMARY KEY (`id`),
  KEY `email_id` (`email_id`)
) ENGINE=InnoDB AUTO_INCREMENT=444210 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `estimate`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `estimate` (
  `id` int NOT NULL AUTO_INCREMENT,
  `estimate_projectid` int DEFAULT '0',
  `estimate_projectname` varchar(100) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `estimate_clientid` int DEFAULT '0',
  `estimate_description` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,
  `estimate_productid` int NOT NULL,
  `estimate_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `estimate_jobinfo` longtext CHARACTER SET latin1 COLLATE latin1_swedish_ci,
  `estimate_printinfo` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `estimate_printordernumber` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `estimate_price` decimal(10,2) NOT NULL DEFAULT '0.00',
  `created` datetime DEFAULT NULL,
  `updated` datetime NOT NULL,
  `estimate_invoiceid` int DEFAULT '0',
  `estimate_managerid` int DEFAULT NULL,
  `estimate_second_manager_id` int DEFAULT NULL,
  `estimate_orig_name` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `estimate_image_name` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `estimate_proofimage` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `estimate_orig_proofimage` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `new_total` decimal(10,2) DEFAULT NULL,
  `estimate_dropboxlink` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `estimate_taxation` enum('Resale','Out Of State','None Taxable Product','Pickup','Local Shipping') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `estimate_tax_value` decimal(10,2) NOT NULL DEFAULT '0.00',
  `sample_only` tinyint(1) NOT NULL DEFAULT '0',
  `oversize` tinyint(1) NOT NULL DEFAULT '0',
  `estimate_drive_link` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `estimate_drive_name` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'AxiomPrintDrive2024',
  `estimate_drive_local_link` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `estimate_drive_folder_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `express` tinyint(1) NOT NULL DEFAULT '0',
  `needed_by_note` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `department_ids` json DEFAULT NULL,
  `production_notes` varchar(5000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `production_status` enum('not_started','in_production','reprint','complete','hard_copy') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'not_started',
  `production_step` enum('embellishment','cutting','outsource','printing','coating_lamination','finishing','fulfillment_pack','complete','not_started') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `production_paused` tinyint NOT NULL DEFAULT '0',
  `production_started_at` timestamp NULL DEFAULT NULL,
  `in_production_old` tinyint(1) NOT NULL DEFAULT '0',
  `prepress_notes` varchar(5000) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `prepress_url` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `prepress_draft_url` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `prepress_status` enum('approved','upload_files','proof_checking','rejected_reupload','rejected_edits','waiting_files','waiting_files_followup','proof_sent','hard_copy_approved','insta_proofed','insta_proof_manual') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `prepress_actions` json DEFAULT NULL,
  `prepress_warnings` json DEFAULT NULL,
  `prepress_notes_to_client` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `prepress_internal_notes` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `outsource_cost` decimal(10,2) DEFAULT NULL,
  `script_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `script_description` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `master_background_front_drive_link` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `master_background_back_drive_link` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `complete_by` timestamp NULL DEFAULT NULL,
  `sample_quantity` int DEFAULT NULL,
  `sample_price` int DEFAULT NULL,
  `design_price` int DEFAULT NULL,
  `active_user` int DEFAULT NULL,
  `visible_for_client` tinyint NOT NULL DEFAULT '1',
  `visible_in_invoice` tinyint NOT NULL DEFAULT '1',
  `estimate_type` enum('estimate','sample','reprint','color_match','sample_and_color_match','reorder') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'estimate',
  `duplicated_from` int DEFAULT NULL,
  `sample_for` int DEFAULT NULL,
  `insta_print_enabled` tinyint(1) NOT NULL DEFAULT '0',
  `category_id` int DEFAULT NULL,
  `batch_id` varchar(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `estimate_invoice_order` int NOT NULL DEFAULT '0',
  `instaproof_url` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `id` (`id`),
  KEY `estimate_projectid` (`estimate_projectid`),
  KEY `estimate_clientid` (`estimate_clientid`),
  KEY `estimate_productid` (`estimate_productid`)
) ENGINE=InnoDB AUTO_INCREMENT=1169264 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `estimate_design_details`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `estimate_design_details` (
  `id` int NOT NULL AUTO_INCREMENT,
  `estimate_id` int NOT NULL,
  `design_type` enum('Upload Design','Work with Our Designers','Send the Files Later','Use Existing Files','No File','Print Ready','Upload Adjustment','Insta Proof','Insta Proof Manual Tier1','Insta Proof Manual Tier2','Manual Proof','Manual Proof Tier1','Manual Proof Tier2') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `notes` varchar(2550) DEFAULT NULL,
  `proofing` enum('no','yes_online_pdf','yes_hard_copy','insta_proof') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `service_level` enum('level_1','level_2') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `service_type` enum('standard','expedite') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `existing_files_from_id` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `estimate_design_details_estimate_id_design_type_index` (`estimate_id`,`design_type`)
) ENGINE=InnoDB AUTO_INCREMENT=87281 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `estimate_handle`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `estimate_handle` (
  `id` int NOT NULL AUTO_INCREMENT,
  `estimate_id` int NOT NULL,
  `type` enum('handle','hard_copy') DEFAULT 'handle',
  `estimate_clientid` int NOT NULL,
  `shipping_method` enum('pick_up','shipping','delivery','service','blind_drop_ship','job_merge','tbd','split') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT 'pick_up',
  `shipping_address_id` int DEFAULT NULL,
  `shipping_boxes` json DEFAULT NULL,
  `system_estimate_boxes` json DEFAULT NULL,
  `system_estimate_extra_boxes` json DEFAULT NULL,
  `shipping_ups_service_code` enum('03','12','02','59','13','01','14') DEFAULT NULL,
  `shipping_ups_price` decimal(10,2) DEFAULT NULL,
  `shipping_weight` float DEFAULT NULL,
  `shipping_volume` float DEFAULT NULL,
  `shipping_company` enum('fedex','ups','usps') DEFAULT NULL,
  `shipping_tracking_number` varchar(100) DEFAULT NULL,
  `shipping_notes` text CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci,
  `shipping_internal_notes` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `shipping_price` float DEFAULT NULL,
  `shipping_ups_saturday_delivery` int NOT NULL DEFAULT '0',
  `label_ups_saturday_delivery` int NOT NULL DEFAULT '0',
  `label_ups_service_code` enum('03','12','02','59','13','01','14') DEFAULT NULL,
  `label_ups_price` decimal(10,2) DEFAULT NULL,
  `pick_up_details` varchar(255) DEFAULT NULL,
  `qc_by` varchar(50) DEFAULT NULL,
  `handling_type` enum('ups','delivery','uber') DEFAULT NULL,
  `merge_with_estimate_id` int DEFAULT NULL,
  `handle_status` enum('Not_ready','Ready','Picked_up','ready_for_shipping','in_transit','delivered') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT 'Not_ready',
  `parent_id` int DEFAULT NULL,
  `name` varchar(256) DEFAULT NULL,
  `quantity` int DEFAULT NULL,
  `shipping_label_url` varchar(125) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `estimate_id` (`estimate_id`),
  KEY `estimate_handle_parent_id_index` (`parent_id`)
) ENGINE=InnoDB AUTO_INCREMENT=159136 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `estimate_prepress_option`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `estimate_prepress_option` (
  `id` int NOT NULL AUTO_INCREMENT,
  `estimate_id` int NOT NULL,
  `version_name` varchar(100) DEFAULT NULL,
  `type` enum('print','foil','spot_uv','white_support','cutline','vdp','die_line','kisscut','material','grommet','book_cover_print','book_cover_foil','book_cover_spot_uv') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `side` enum('front','back') NOT NULL,
  `drive_file_id` varchar(100) DEFAULT NULL,
  `approved_drive_file_id` varchar(100) DEFAULT NULL,
  `approved_drive_file_name` varchar(255) DEFAULT NULL,
  `approved_drive_file_icon_link` varchar(255) DEFAULT NULL,
  `approved_file_local_path` varchar(500) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `drive_file_name` varchar(200) DEFAULT NULL,
  `drive_file_icon_link` varchar(200) DEFAULT NULL,
  `not_need_file` tinyint NOT NULL DEFAULT '0',
  `material_from_id` int DEFAULT NULL,
  `die_line_from_id` int DEFAULT NULL,
  `need_white_support` tinyint(1) NOT NULL DEFAULT '0',
  `need_vdp` tinyint NOT NULL DEFAULT '0',
  `has_cut` tinyint NOT NULL DEFAULT '0',
  `version_order` int DEFAULT NULL,
  `imposed_file_id` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `imposed_file_name` varchar(200) DEFAULT NULL,
  `imposed_file_icon_link` varchar(200) DEFAULT NULL,
  `prepress_n_up` int DEFAULT NULL,
  `fpo_file_id` varchar(100) DEFAULT NULL,
  `fpo_file_name` varchar(200) DEFAULT NULL,
  `fpo_file_icon_link` varchar(200) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=268236 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `estimate_stage`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `estimate_stage` (
  `id` int NOT NULL AUTO_INCREMENT,
  `estimate_id` int NOT NULL,
  `estimate_stage` enum('order','prepress','processing','handling','complete') NOT NULL,
  `estimate_substage` enum('new_client','reorder','ongoing','follow_up','cad_template','design','tier_1','tier_2','payment','imposition','production','packing','pickup','shipping','delivery_install','job_merge','final_payment','done','canceled','ticket') NOT NULL,
  `stage_in_date` timestamp NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `estimate_id` (`estimate_id`),
  KEY `estimate_substage` (`estimate_substage`),
  KEY `estimate_stage` (`estimate_stage`),
  KEY `estimate_stage_stage_in_date_index` (`stage_in_date` DESC),
  KEY `idx_substage_date` (`estimate_substage`,`stage_in_date` DESC)
) ENGINE=InnoDB AUTO_INCREMENT=148992 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `estimate_team_members`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `estimate_team_members` (
  `id` int NOT NULL AUTO_INCREMENT,
  `estimate_id` int NOT NULL,
  `user_id` int NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `estimate_team_members_estimate_id_user_id_uindex` (`estimate_id`,`user_id`)
) ENGINE=InnoDB AUTO_INCREMENT=469374 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `estimateoption`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `estimateoption` (
  `id` int NOT NULL AUTO_INCREMENT,
  `estimate_id` int NOT NULL DEFAULT '0',
  `optionVariableId` int DEFAULT NULL,
  `optionVariableItemId` int DEFAULT NULL,
  `estimate_option_name` varchar(200) DEFAULT NULL,
  `estimate_option_value` varchar(200) DEFAULT NULL,
  `selected` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `selected_image` varchar(255) DEFAULT NULL,
  `estimate_option_custom_value` varchar(255) DEFAULT NULL,
  `estimate_option_config` longtext,
  `estimate_option_highlighted` tinyint(1) NOT NULL DEFAULT '0',
  `variabletype` varchar(255) DEFAULT NULL,
  `hidden` tinyint(1) NOT NULL DEFAULT '0',
  `internal` int NOT NULL DEFAULT '0',
  `order` tinyint unsigned DEFAULT NULL,
  `material_id` int DEFAULT NULL,
  `custom_material_id` int DEFAULT NULL,
  `die_line_id` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `estimate_id` (`estimate_id`),
  KEY `id` (`id`),
  CONSTRAINT `estid` FOREIGN KEY (`estimate_id`) REFERENCES `estimate` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=1231565 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `failed_jobs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `failed_jobs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `uuid` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `connection` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `queue` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `payload` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `exception` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `failed_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `failed_jobs_uuid_unique` (`uuid`)
) ENGINE=InnoDB AUTO_INCREMENT=15082 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `geo_sub_type`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `geo_sub_type` (
  `id` int NOT NULL AUTO_INCREMENT,
  `geo_type_id` int DEFAULT NULL,
  `name` varchar(100) NOT NULL,
  `abbreviation` varchar(100) DEFAULT NULL,
  `icon_url` varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=82 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `geo_type`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `geo_type` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(200) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=44 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `geolocations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `geolocations` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `country` varchar(255) DEFAULT NULL,
  `state` varchar(255) DEFAULT NULL,
  `county` varchar(255) DEFAULT NULL,
  `city` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `zip` varchar(255) DEFAULT NULL,
  `project_id` int NOT NULL,
  `invoice_id` int NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=4255 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `holidays`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `holidays` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(300) NOT NULL,
  `repeat_on` enum('does_not_repeat','weekly_on_same_day','monthly_on_same_day_and_week','monthly_on_same_date','annually_on_same_date') NOT NULL DEFAULT 'does_not_repeat',
  `date` date NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=24 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `homepage_banner`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `homepage_banner` (
  `id` int NOT NULL AUTO_INCREMENT,
  `bgImgUrl` text NOT NULL,
  `html` longtext NOT NULL,
  `isMobile` tinyint(1) NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT '0',
  `title` text,
  `transition_duration` int DEFAULT NULL,
  `autoplay_speed` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=1732 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `invoice`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `invoice` (
  `id` int NOT NULL AUTO_INCREMENT,
  `invoice_projectid` int DEFAULT NULL,
  `invoice_clientid` int DEFAULT NULL,
  `invoice_total_payment` decimal(10,2) NOT NULL DEFAULT '0.00',
  `invoice_creation_date` datetime DEFAULT NULL,
  `payment_status` enum('paid','unpaid','partial','void') CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL DEFAULT 'unpaid',
  `invoice_managerid` int DEFAULT NULL,
  `invoice_enable_partial_payment` tinyint NOT NULL DEFAULT '0',
  `invoice_shipping` decimal(10,2) NOT NULL DEFAULT '0.00',
  `invoice_discount` decimal(10,2) NOT NULL DEFAULT '0.00',
  `invoice_total_payment_done` decimal(10,2) NOT NULL DEFAULT '0.00',
  `invoice_additionalvalue` decimal(10,2) NOT NULL DEFAULT '0.00',
  `invoice_subtotal_payment` decimal(10,2) NOT NULL DEFAULT '0.00',
  `updated_at` datetime DEFAULT NULL,
  `invoice_partial_amount` decimal(10,2) NOT NULL DEFAULT '0.00',
  `commission_status` enum('approved','rejected','partial') CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `comission_payment_status` enum('paid','unpaid') NOT NULL DEFAULT 'unpaid',
  `commission_amount` decimal(8,2) NOT NULL DEFAULT '0.00',
  `commission_note` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `project_done_date` timestamp NULL DEFAULT NULL,
  `payment_due_date` timestamp NULL DEFAULT NULL,
  `commission_payment_id` int DEFAULT NULL,
  `commission_project_notes` text,
  `create_by_order` tinyint(1) NOT NULL DEFAULT '0',
  `invoice_client_user_id` int NOT NULL DEFAULT '-1',
  `invoice_promo_code_id` int DEFAULT NULL,
  `invoice_promo_code_discount_value` float DEFAULT NULL,
  `PO_number` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `invoice_new_tax_value` decimal(10,2) DEFAULT NULL,
  `order_n` int DEFAULT NULL,
  `ready_for_production` enum('on','auto','off') NOT NULL DEFAULT 'auto',
  `payment_term` enum('pay_now','pay_upon_approval','net_15','net_30','net_45','net_60','pay_on_complete') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL DEFAULT 'pay_upon_approval',
  `invoice_type` enum('invoice','estimate','bad_debt') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL DEFAULT 'invoice',
  `invoice_done_date` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `invoice_clientid` (`invoice_clientid`),
  KEY `invoice_manager` (`invoice_managerid`),
  KEY `invoice_clientid_2` (`invoice_clientid`),
  KEY `invoice_managerid` (`invoice_managerid`),
  KEY `invoice_projectid` (`invoice_projectid`),
  KEY `invoice_clientid_3` (`invoice_clientid`),
  KEY `payment_status` (`payment_status`),
  CONSTRAINT `invoiclient` FOREIGN KEY (`invoice_clientid`) REFERENCES `customer` (`id`) ON DELETE SET NULL ON UPDATE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=127645 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `invoiceadditionalcharge`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `invoiceadditionalcharge` (
  `id` int NOT NULL AUTO_INCREMENT,
  `invoice_id` int NOT NULL,
  `invoice_additional_title` varchar(200) DEFAULT NULL,
  `invoice_additional_price` decimal(10,2) DEFAULT NULL,
  `invoice_additional_description` text,
  `invoice_additional_for_estimate` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `invoice_id` (`invoice_id`),
  KEY `invoice_id_2` (`invoice_id`),
  CONSTRAINT `invaddcharge` FOREIGN KEY (`invoice_id`) REFERENCES `invoice` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=9463 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `invoiceestimate`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `invoiceestimate` (
  `id` int NOT NULL AUTO_INCREMENT,
  `invoice_id` int NOT NULL DEFAULT '0',
  `invoice_estimateid` int NOT NULL DEFAULT '0',
  `invoice_estprojectid` int DEFAULT '0',
  `invoice_estclientid` int NOT NULL DEFAULT '0',
  `invoice_estcount` int NOT NULL DEFAULT '0',
  `invoice_estproductid` int NOT NULL DEFAULT '0',
  `invoice_estprice` decimal(10,2) NOT NULL DEFAULT '0.00',
  PRIMARY KEY (`id`),
  KEY `invoice_id` (`invoice_id`),
  KEY `invoice_estimateid` (`invoice_estimateid`),
  KEY `invoice_projectid` (`invoice_estprojectid`)
) ENGINE=InnoDB AUTO_INCREMENT=268088 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `invoicepayment`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `invoicepayment` (
  `id` int NOT NULL AUTO_INCREMENT,
  `invoice_paymentdone` decimal(10,2) NOT NULL DEFAULT '0.00',
  `invoice_paymentdate` datetime DEFAULT NULL,
  `invoice_id` int NOT NULL DEFAULT '0',
  `invoice_paymenttype` enum('full','partial') DEFAULT NULL,
  `invoice_detail` varchar(220) DEFAULT NULL,
  `invoice_payment_mode` enum('cash','credit','donation','cheque','client_card','zelle','venmo','store_credit','ach') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `is_refund` tinyint NOT NULL DEFAULT '0',
  `refund_type` enum('overpayment','customer_service') DEFAULT NULL,
  `invoice_payment_snapshot_url` varchar(100) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `invoice_id` (`invoice_id`)
) ENGINE=InnoDB AUTO_INCREMENT=93168 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `job_batches`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `job_batches` (
  `id` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `total_jobs` int NOT NULL,
  `pending_jobs` int NOT NULL,
  `failed_jobs` int NOT NULL,
  `failed_job_ids` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `options` mediumtext COLLATE utf8mb4_unicode_ci,
  `cancelled_at` int DEFAULT NULL,
  `created_at` int NOT NULL,
  `finished_at` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `jobs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `jobs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `queue` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `payload` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `attempts` tinyint unsigned NOT NULL,
  `reserved_at` int unsigned DEFAULT NULL,
  `available_at` int unsigned NOT NULL,
  `created_at` int unsigned NOT NULL,
  PRIMARY KEY (`id`),
  KEY `jobs_queue_index` (`queue`)
) ENGINE=InnoDB AUTO_INCREMENT=210287 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `local_menu`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `local_menu` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `order` int unsigned NOT NULL,
  `hidden` tinyint NOT NULL DEFAULT '0',
  `products` json DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=1003 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `location_categories`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `location_categories` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `location_id` bigint unsigned NOT NULL,
  `category_id` bigint unsigned NOT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `location_categories_location_id_category_id_unique` (`location_id`,`category_id`)
) ENGINE=InnoDB AUTO_INCREMENT=694 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `locations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `locations` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_id` int DEFAULT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `login` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `password` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `department_id` int DEFAULT NULL,
  `production_step` varchar(1048) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `equipment` varchar(2048) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `address` varchar(2048) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `room_id` int unsigned DEFAULT NULL,
  `sub_room_id` bigint unsigned DEFAULT NULL,
  `shelf_id` int unsigned DEFAULT NULL,
  `rack_id` int unsigned DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL,
  `shelf_required` tinyint(1) NOT NULL DEFAULT '0',
  `color_name` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `color_hex` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `locations_name_index` (`name`),
  KEY `locations_login_index` (`login`),
  KEY `locations_department_id_index` (`department_id`),
  KEY `locations_room_id_index` (`room_id`),
  KEY `locations_shelf_id_index` (`shelf_id`),
  KEY `locations_rack_id_index` (`rack_id`),
  KEY `locations_sub_room_id_index` (`sub_room_id`)
) ENGINE=InnoDB AUTO_INCREMENT=87 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `logs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `logs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int DEFAULT NULL,
  `project_id` int DEFAULT NULL,
  `estimate_id` int DEFAULT NULL,
  `invoice_id` int DEFAULT NULL,
  `client_id` int DEFAULT NULL,
  `payment_id` int DEFAULT NULL,
  `designer_id` int DEFAULT NULL,
  `active_user_id` int DEFAULT NULL,
  `event_type` enum('packing_labels_downloaded','call_received','note_created','design_proof_created','design_proof_rejected','design_proof_approved','project_stage_updated','invoice_paid','invoice_created','invoice_deleted','designer_added','estimate_created','estimate_updated','invoice_updated','designer_removed','project_created','due_date_changed','estimate_image_changed','active_user_changed','shipping_method_changed','estimate_image_added_from_qr','estimate_linked','estimate_unlinked','notification_sent','task_created','work_logged','drive_change','call_created','email_sent','email_status_updated','team_member_added','team_member_removed','prepress_status_updated','invoice_note_created','qr_scanned','in_production_selected','job_ticket_sent_to_department','prepress_url_generated','estimate_batched','project_viewed','estimate_stage_updated','estimate_team_member_added','estimate_team_member_removed','invoice_email_sent','invoice_downloaded','design_proof_email_sent','design_proof_reminder_email_sent','ready_for_pickup_email_sent','packing_slip_created','design_type_updated','design_service_type_updated','estimate_due_date_updated','packing_slip_downloaded','estimate_batched_failed','prepress_approved','product_shipped_email_sent','invoice_refund','needed_by_note','tracking_status_updated','order_pickup_reminder_email_sent','shipping_label_created','tracking_number_updated','packing_slip_created_auto_applied','prepress_generated','batched','design_proofing_updated','message_created','prepress_draft_approved','prepress_draft_rejected','production_step_updated','instaproof_url_updated') DEFAULT NULL,
  `event` text CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `created_at` datetime NOT NULL,
  `oldStage` varchar(255) DEFAULT NULL,
  `oldSubstage` varchar(255) DEFAULT NULL,
  `newStage` varchar(255) DEFAULT NULL,
  `newSubstage` varchar(255) DEFAULT NULL,
  `note_text` text CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci,
  `note_managers` json DEFAULT NULL,
  `reminded` tinyint(1) DEFAULT NULL,
  `is_read` tinyint NOT NULL DEFAULT '1',
  `notified` tinyint(1) DEFAULT '0',
  `task_due_date` timestamp NULL DEFAULT NULL,
  `task_remind_date` timestamp NULL DEFAULT NULL,
  `task_status` enum('done','pending','overdue') DEFAULT NULL,
  `task_type` enum('collect_payment','send_follow_up_email','missing_invoice','attention_needed','validate_the_lead','onboard_the_lead','packing_slip_missing','proofing_delay','approval_delay','customer_credit_limit_exceeded','late_project','late_pickup','convert_to_invoice','resend_email','clarify_due_date','missing_prepress_file','check_client_notes','overpayment','shipping_method_not_selected') DEFAULT NULL,
  `has_attachment` tinyint(1) NOT NULL DEFAULT '0',
  `attachments` json DEFAULT NULL,
  `thread_id` int DEFAULT NULL,
  `reply_to_note_id` int DEFAULT NULL,
  `email_id` int DEFAULT NULL,
  `private` tinyint(1) NOT NULL DEFAULT '0',
  `for_commission` tinyint(1) NOT NULL DEFAULT '0',
  `issue_group` enum('customer_service','prepress_files','production','shipping','delivery','reprint','other','installation','payment_invoice') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `issue_type` enum('due_date','product_knowledge','wrong_pricing','personal_conflict','luck_of_response','size','page_count','white_support','foil_spot_uv_file','front_and_back_issue','file_naming_issue','wrong_material','color_issue','bad_packaging','uncentered_cut','not_clean_order','wrong_address','wrong_shipping_type','installation','unsatisfied_installation','late_on_arrival','disassembled','damaged_product','lost_package','missed_deadline','missed_step','over_double_payment','unsatisfied_order','missed_turnaround') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `pinned` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `project_id` (`project_id`),
  KEY `task_status` (`task_status`),
  KEY `event_type` (`event_type`),
  KEY `task_type` (`task_type`),
  KEY `task_type_2` (`task_type`),
  KEY `logs_estimate_id_index` (`estimate_id`)
) ENGINE=InnoDB AUTO_INCREMENT=6856880 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `manager_queue`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `manager_queue` (
  `id` int NOT NULL AUTO_INCREMENT,
  `manager_id` int NOT NULL,
  `your_turn` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `materials`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `materials` (
  `id` int NOT NULL AUTO_INCREMENT,
  `photo_url` varchar(200) DEFAULT NULL,
  `name` varchar(200) DEFAULT NULL,
  `material` enum('paper_text','vinyl','bopp_label','adhesive_vinyl','cardboard','foil','spot_uv','uv_coating','plastic','lamination','magnet','wood','pvc','foam','acrylic','coroplast','aluminnum','spiral_coil','wire_o','edge_paint','coating','paper_cover','film') DEFAULT NULL,
  `department_ids` json DEFAULT NULL,
  `type` enum('sheet','role','adhesive_roll','hardware','binding','paint','item','solution') DEFAULT NULL,
  `production_step` enum('embellishment','cutting','outsource','printing','coating_lamination','finishing','fulfillment_pack','complete') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `thickness` decimal(10,4) DEFAULT NULL,
  `t_measure` int DEFAULT NULL,
  `size` varchar(200) DEFAULT NULL,
  `size_w` decimal(10,2) DEFAULT NULL,
  `size_h` decimal(10,2) DEFAULT NULL,
  `weight` decimal(10,4) DEFAULT NULL,
  `w_measure` enum('each','100_sh_8.5x11','10_sh_8.5x11','100_sh_12x12') DEFAULT NULL,
  `color_name` varchar(100) DEFAULT NULL,
  `color_hex` varchar(100) DEFAULT NULL,
  `proof_image_url` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `back_proof_image_url` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `proof_image_type` enum('texture','background') DEFAULT NULL,
  `website_image_url` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `swatch_name` varchar(100) DEFAULT NULL,
  `supplier` varchar(200) DEFAULT NULL,
  `manufacturer` varchar(100) DEFAULT NULL,
  `stock` int DEFAULT NULL,
  `location` varchar(100) DEFAULT NULL,
  `code` varchar(100) DEFAULT NULL,
  `axiom_id` varchar(100) DEFAULT NULL,
  `cost` decimal(10,3) DEFAULT NULL,
  `c_measure` int DEFAULT NULL,
  `geo_type_id` int DEFAULT NULL,
  `geo_sub_type_id` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=329 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `menu_items`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `menu_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `order` int unsigned NOT NULL,
  `hidden` tinyint NOT NULL DEFAULT '0',
  `products` json DEFAULT NULL,
  `popular_products` json DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=4829 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `migration`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `migration` (
  `version` varchar(180) NOT NULL,
  `apply_time` int DEFAULT NULL,
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `migrations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `migrations` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `migration` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `batch` int NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=110 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `notification`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `notification` (
  `id` int NOT NULL AUTO_INCREMENT,
  `message` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL,
  `manager_id` int NOT NULL,
  `customer_manager_id` int DEFAULT NULL,
  `customer_id` int DEFAULT NULL,
  `project_id` int DEFAULT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT '0',
  `type` enum('payment_failed','notify','payment_success','task_created') NOT NULL DEFAULT 'payment_success',
  `log_id` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `manager_id` (`manager_id`),
  KEY `type` (`type`),
  KEY `is_read` (`is_read`)
) ENGINE=InnoDB AUTO_INCREMENT=1490839 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `old_auth_assignment`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `old_auth_assignment` (
  `item_name` varchar(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `user_id` varchar(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `created_at` int DEFAULT NULL,
  PRIMARY KEY (`item_name`,`user_id`),
  CONSTRAINT `old_auth_assignment_ibfk_1` FOREIGN KEY (`item_name`) REFERENCES `old_auth_item` (`name`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `old_auth_item`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `old_auth_item` (
  `name` varchar(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `type` smallint NOT NULL,
  `description` text CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci,
  `rule_name` varchar(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci DEFAULT NULL,
  `data` blob,
  `created_at` int DEFAULT NULL,
  `updated_at` int DEFAULT NULL,
  PRIMARY KEY (`name`),
  KEY `rule_name` (`rule_name`),
  KEY `idx-auth_item-type` (`type`),
  CONSTRAINT `old_auth_item_ibfk_1` FOREIGN KEY (`rule_name`) REFERENCES `old_auth_rule` (`name`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `old_auth_item_child`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `old_auth_item_child` (
  `parent` varchar(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `child` varchar(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  PRIMARY KEY (`parent`,`child`),
  KEY `child` (`child`),
  CONSTRAINT `old_auth_item_child_ibfk_1` FOREIGN KEY (`parent`) REFERENCES `old_auth_item` (`name`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `old_auth_item_child_ibfk_2` FOREIGN KEY (`child`) REFERENCES `old_auth_item` (`name`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `old_auth_rule`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `old_auth_rule` (
  `name` varchar(64) CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci NOT NULL,
  `data` blob,
  `created_at` int DEFAULT NULL,
  `updated_at` int DEFAULT NULL,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `old_migration`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `old_migration` (
  `version` varchar(180) NOT NULL,
  `apply_time` int DEFAULT NULL,
  PRIMARY KEY (`version`)
) ENGINE=InnoDB DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `pages`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pages` (
  `id` int NOT NULL AUTO_INCREMENT,
  `template_id` int NOT NULL,
  `name` varchar(100) DEFAULT NULL,
  `img_path` varchar(100) DEFAULT NULL,
  `width` float DEFAULT NULL,
  `height` float DEFAULT NULL,
  `cutline` float DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `template_id` (`template_id`),
  CONSTRAINT `pages_ibfk_1` FOREIGN KEY (`template_id`) REFERENCES `design_templates` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=46 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `personal_access_tokens`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `personal_access_tokens` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `tokenable_type` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `tokenable_id` bigint unsigned NOT NULL,
  `name` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `token` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `abilities` text COLLATE utf8mb4_unicode_ci,
  `last_used_at` timestamp NULL DEFAULT NULL,
  `expires_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `personal_access_tokens_token_unique` (`token`),
  KEY `personal_access_tokens_tokenable_type_tokenable_id_index` (`tokenable_type`,`tokenable_id`)
) ENGINE=InnoDB AUTO_INCREMENT=36946 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `process_manager`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `process_manager` (
  `id` int NOT NULL AUTO_INCREMENT,
  `resource_type` enum('estimate') COLLATE utf8mb4_unicode_ci NOT NULL,
  `resource_id` int NOT NULL,
  `process_type` enum('prepress_generate','log_work') COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` enum('processing','completed','failed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'processing',
  `initiated_by_user_id` int NOT NULL,
  `result` json DEFAULT NULL,
  `error_message` text COLLATE utf8mb4_unicode_ci,
  `started_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `process_manager_resource_type_process_status_idx` (`resource_type`,`resource_id`,`process_type`,`status`)
) ENGINE=InnoDB AUTO_INCREMENT=888 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `product`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `product` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `product_category_id` int unsigned DEFAULT '0',
  `title` varchar(255) DEFAULT NULL,
  `url` varchar(255) DEFAULT NULL,
  `image` varchar(255) DEFAULT NULL,
  `thumbnail` varchar(255) DEFAULT NULL,
  `type` enum('square_fit','fix','catalog','simple','sticker','custom','bwfix','custom_html') NOT NULL,
  `meta_title` varchar(255) DEFAULT NULL,
  `meta_keywords` varchar(255) DEFAULT NULL,
  `meta_description` varchar(500) DEFAULT NULL,
  `information` mediumtext,
  `finishing` mediumtext,
  `file_prep` mediumtext,
  `turnaround_and_shipping` mediumtext,
  `about_banner_printing` mediumtext,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `visible` tinyint(1) NOT NULL DEFAULT '1',
  `instagram_hashtag` varchar(255) DEFAULT NULL,
  `limit_square_fit` double DEFAULT '0',
  `open_advanced_options` tinyint(1) NOT NULL DEFAULT '0',
  `created` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `product_subcategory_id` int DEFAULT '0',
  `product_turnaround_tooltip` text,
  `ptypep` varchar(150) DEFAULT NULL,
  `discount_percents` datetime DEFAULT NULL,
  `short_description` varchar(250) DEFAULT NULL,
  `additional_info` text,
  `video` text,
  `faq` text,
  `templates_information` text,
  `about` text,
  `updated` datetime DEFAULT NULL,
  `order` int unsigned DEFAULT NULL,
  `menu_item_id` int unsigned DEFAULT NULL,
  `public_title` varchar(255) DEFAULT NULL,
  `custom_html` text,
  `non_taxable` tinyint(1) DEFAULT NULL,
  `clientSatisfaction` int DEFAULT NULL,
  `clientsInterested` int DEFAULT NULL,
  `need_design` tinyint(1) NOT NULL DEFAULT '1',
  `redirect_url` text,
  `shipping_type` enum('disabled','percentage','third_party') NOT NULL DEFAULT 'percentage',
  `shipping_base_price` float DEFAULT NULL,
  `shipping_coefficient` float DEFAULT NULL,
  `shipping_oversize` tinyint(1) DEFAULT NULL,
  `shipping_disable` tinyint(1) DEFAULT NULL,
  `shipping_oversize_base_price` int DEFAULT NULL,
  `shipping_oversize_coefficient` int DEFAULT NULL,
  `available_for_customers` json DEFAULT NULL,
  `available_for_categories` longtext,
  `available_for_websites` json DEFAULT NULL,
  `helper_notes` longtext,
  `canonical` varchar(255) DEFAULT NULL,
  `slideshow_web_id` int DEFAULT NULL,
  `slideshow_mobile_id` int DEFAULT NULL,
  `calc_error_msg` varchar(5000) DEFAULT NULL,
  `formula` varchar(5000) DEFAULT NULL,
  `packing_weight_formula` varchar(1000) DEFAULT NULL,
  `packing_volume_formula` varchar(1000) DEFAULT NULL,
  `packing_boxes` json DEFAULT NULL,
  `packing_box_length_formula` varchar(1000) DEFAULT NULL,
  `packing_box_height_formula` varchar(1000) DEFAULT NULL,
  `packing_box_width_formula` varchar(1000) DEFAULT NULL,
  `packing_type` enum('box','flat','rolled') NOT NULL DEFAULT 'box',
  `for_designers` json DEFAULT NULL,
  `bleed` enum('0','0.25','0.125','0.5') CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL DEFAULT '0.25',
  `dpi` enum('72','150','300') NOT NULL DEFAULT '300',
  `product_drive_name` varchar(100) NOT NULL DEFAULT 'CRMProducts',
  `product_drive_folder_name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL,
  `department_ids` json DEFAULT NULL,
  `print_info` json DEFAULT NULL,
  `prepress_ready` tinyint NOT NULL DEFAULT '0',
  `prepress_file_structure` enum('no_file','simple','catalog','simple_vdp','simple_shape','cad_jobs','design_only') CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL DEFAULT 'simple',
  `prepress_preview` enum('3d','none','mockup') NOT NULL DEFAULT '3d',
  `prepress_ai_arrow` tinyint(1) NOT NULL DEFAULT '0',
  `online_ready` tinyint NOT NULL DEFAULT '0',
  `production_ready` tinyint NOT NULL DEFAULT '0',
  `sample_fee` tinyint(1) NOT NULL DEFAULT '0',
  `sample_type` enum('standart','large_format') DEFAULT NULL,
  `sample_base` int DEFAULT NULL,
  `sample_per_price` int DEFAULT NULL,
  `sample_msg` varchar(500) DEFAULT NULL,
  `pinned` tinyint NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `pcatfk` (`product_category_id`),
  CONSTRAINT `pcatfk` FOREIGN KEY (`product_category_id`) REFERENCES `productcategory` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=1309 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `product_group`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `product_group` (
  `id` int NOT NULL AUTO_INCREMENT,
  `products_list` varchar(120) NOT NULL,
  `best_sellers` varchar(120) DEFAULT NULL,
  `recommended_for_you` varchar(120) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `product_packing_options`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `product_packing_options` (
  `id` int NOT NULL AUTO_INCREMENT,
  `product_id` int NOT NULL,
  `packing_type` enum('box','flat','rolled') DEFAULT NULL,
  `packing_weight_formula` varchar(1000) DEFAULT NULL,
  `packing_volume_formula` varchar(1000) DEFAULT NULL,
  `packing_boxes` json DEFAULT NULL,
  `packing_box_length_formula` varchar(1000) DEFAULT NULL,
  `packing_box_height_formula` varchar(1000) DEFAULT NULL,
  `packing_box_width_formula` varchar(1000) DEFAULT NULL,
  `related_to` int DEFAULT NULL,
  `related_to_values` json DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=329 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `product_prepress_options`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `product_prepress_options` (
  `id` int NOT NULL AUTO_INCREMENT,
  `product_id` int NOT NULL,
  `type` enum('print','foil','spot_uv','kisscut','cutline','vdp','die_line','material','grommet','book_cover_print','book_cover_foil','book_cover_spot_uv') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `front_related_to_id` int DEFAULT NULL,
  `front_related_item_ids` json DEFAULT NULL,
  `back_related_to_id` int DEFAULT NULL,
  `back_related_item_ids` json DEFAULT NULL,
  `front_material_from_id` int DEFAULT NULL,
  `back_material_from_id` int DEFAULT NULL,
  `front_white_related_to_id` int DEFAULT NULL,
  `front_white_related_item_ids` json DEFAULT NULL,
  `back_white_related_to_id` int DEFAULT NULL,
  `back_white_related_item_ids` json DEFAULT NULL,
  `front_die_line_from_id` int DEFAULT NULL,
  `back_die_line_from_id` int DEFAULT NULL,
  `front_vdp_related_to_id` int DEFAULT NULL,
  `front_vdp_related_item_ids` json DEFAULT NULL,
  `back_vdp_related_to_id` int DEFAULT NULL,
  `back_vdp_related_item_ids` json DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=26858 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `product_production`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `product_production` (
  `id` int NOT NULL AUTO_INCREMENT,
  `product_id` int NOT NULL,
  `script_name` varchar(100) DEFAULT NULL,
  `script_for` enum('prepress','prepress_2.0') NOT NULL DEFAULT 'prepress',
  `script_description` varchar(5000) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `manager_id` int DEFAULT NULL,
  `department` int DEFAULT NULL,
  `printed_at` json DEFAULT NULL,
  `default` tinyint(1) NOT NULL DEFAULT '0',
  `master_background_front_name` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `master_background_front_drive_link` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `master_background_back_name` varchar(200) DEFAULT NULL,
  `master_background_back_drive_link` varchar(200) DEFAULT NULL,
  `insta_print` tinyint(1) NOT NULL DEFAULT '0',
  `n_up` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=16048 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `product_production_material_folder_options`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `product_production_material_folder_options` (
  `id` int NOT NULL AUTO_INCREMENT,
  `product_production_id` int NOT NULL,
  `related_to_material_id` int NOT NULL,
  `side` int NOT NULL,
  `folder_id` varchar(100) NOT NULL,
  `folder_name` varchar(100) NOT NULL,
  `folder_drive_name` varchar(100) NOT NULL,
  `combine_logic` varchar(255) NOT NULL DEFAULT 'stagger',
  PRIMARY KEY (`id`),
  KEY `product_production_id` (`product_production_id`)
) ENGINE=InnoDB AUTO_INCREMENT=8419 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `product_production_options`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `product_production_options` (
  `id` int NOT NULL AUTO_INCREMENT,
  `product_production_id` int NOT NULL,
  `related_to_id` int NOT NULL,
  `related_to_item_ids` json NOT NULL,
  PRIMARY KEY (`id`),
  KEY `product_production_id` (`product_production_id`)
) ENGINE=InnoDB AUTO_INCREMENT=13428 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `product_variable_filters`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `product_variable_filters` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `product_variable_id` int DEFAULT NULL,
  `product_variable_item_id` int DEFAULT NULL,
  `relatedTo` int DEFAULT NULL,
  `relatedItems` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `product_variable_id` (`product_variable_id`),
  KEY `product_variable_item_id` (`product_variable_item_id`)
) ENGINE=InnoDB AUTO_INCREMENT=34778 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `product_variable_item`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `product_variable_item` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `variable_id` int NOT NULL,
  `order` int DEFAULT NULL,
  `default` tinyint(1) NOT NULL DEFAULT '0',
  `isHidden` tinyint NOT NULL DEFAULT '0',
  `custom` tinyint NOT NULL DEFAULT '0',
  `title` varchar(255) NOT NULL,
  `value` float(11,4) DEFAULT NULL,
  `base` float(11,4) DEFAULT NULL,
  `mass` float(11,4) DEFAULT NULL,
  `thick` float(11,4) DEFAULT NULL,
  `radius` float(11,4) DEFAULT NULL,
  `corners` enum('0','2','4') DEFAULT NULL,
  `dayCount` int DEFAULT NULL,
  `cost` float(11,4) DEFAULT NULL,
  `name` varchar(255) DEFAULT NULL,
  `image` varchar(255) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `highlighted` int NOT NULL DEFAULT '0',
  `punch_file` varchar(200) DEFAULT NULL,
  `punch_position` enum('top_left','top_center','top_right','middle_left','middle_center','middle_right','bottom_left','bottom_center','bottom_right') DEFAULT NULL,
  `equilateral` tinyint(1) NOT NULL DEFAULT '0',
  `configs` json DEFAULT NULL,
  `foil_color` varchar(200) DEFAULT NULL,
  `unwind_direction` int DEFAULT NULL,
  `material_id` int DEFAULT NULL,
  `die_line_id` int DEFAULT NULL,
  `redirect_url` varchar(500) DEFAULT NULL,
  `binding_type` enum('saddle','perfect','wire','spiral','hard_cover') DEFAULT NULL,
  `binding_gap` decimal(10,2) DEFAULT NULL,
  `binding_side` enum('left','top') DEFAULT NULL,
  `multiple` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `variable_id` (`variable_id`)
) ENGINE=InnoDB AUTO_INCREMENT=34597 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `product_variables`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `product_variables` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `product_id` int NOT NULL,
  `type` enum('size_new','list','quantity_list','text','number','quantity','turnaround','size_3D','material_list','punch_list','radius_list','folding_list','perf_list','shape_list','unwind_list','binding_list','upload_file','hanging_list') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `title` varchar(255) NOT NULL,
  `base` varchar(50) DEFAULT NULL,
  `default_value` varchar(20) DEFAULT NULL,
  `hidden` tinyint(1) NOT NULL DEFAULT '0',
  `internal` tinyint NOT NULL DEFAULT '0',
  `preview` int DEFAULT '0',
  `preview_mode` enum('top','next','icon','top_photo','next_photo','next3') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `order` int DEFAULT NULL,
  `configs` longtext CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci,
  `hasVersions` int NOT NULL DEFAULT '0',
  `custom` tinyint(1) NOT NULL DEFAULT '0',
  `image_thumb_from` enum('upload','material') NOT NULL DEFAULT 'upload',
  `tooltip` longtext CHARACTER SET latin1 COLLATE latin1_swedish_ci,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=5847 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `productcategory`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `productcategory` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `title` varchar(255) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `id` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=121 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `productgallery`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `productgallery` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `product_id` int unsigned NOT NULL DEFAULT '0',
  `orig_name` varchar(200) DEFAULT NULL,
  `image_name` varchar(255) DEFAULT NULL,
  `pid` varchar(155) NOT NULL DEFAULT '0',
  `image_path` varchar(200) DEFAULT NULL,
  `thumb_path` varchar(200) DEFAULT NULL,
  `order` int NOT NULL DEFAULT '0',
  `alt` varchar(255) NOT NULL DEFAULT '',
  `estimate_thumbnail` tinyint(1) NOT NULL DEFAULT '0',
  `related_variable_id` int DEFAULT NULL,
  `related_variable_item_ids` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `pgallfk` (`product_id`),
  KEY `order` (`order`)
) ENGINE=InnoDB AUTO_INCREMENT=4188 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `production_stage`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `production_stage` (
  `id` int NOT NULL AUTO_INCREMENT,
  `estimate_id` int NOT NULL,
  `stage` enum('printing','coating_lamination','decorative_finishing','final_die_cutting','finishing_folding_binding','fulfillment_mailing_installation') NOT NULL,
  `stage_in_date` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=14736 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `project`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `project` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `projectname` varchar(255) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL,
  `projectclientid` int DEFAULT NULL,
  `projectcompletedate` timestamp NULL DEFAULT NULL,
  `projectnumber` varchar(255) DEFAULT NULL,
  `projectquicknotes` text,
  `projectrush` int NOT NULL DEFAULT '0',
  `projectdropboxlink` varchar(255) DEFAULT NULL,
  `projectdesigner` int DEFAULT '0',
  `projectlevel` varchar(100) DEFAULT NULL,
  `projectdesigntype` varchar(100) DEFAULT NULL,
  `projectnotes` text,
  `projecttime` varchar(200) DEFAULT NULL,
  `created_by_client_side` tinyint(1) NOT NULL DEFAULT '0',
  `search_string` text CHARACTER SET utf8mb3 COLLATE utf8mb3_unicode_ci,
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `active_user` int DEFAULT NULL,
  `visibleForClient` tinyint(1) NOT NULL DEFAULT '1',
  `projectCustomerUsers` json DEFAULT NULL,
  `active_customer_user` int DEFAULT NULL,
  `created_from_domain` varchar(100) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `projectclientid` (`projectclientid`),
  KEY `projectrush` (`projectrush`),
  KEY `id` (`id`),
  KEY `projectname` (`projectname`),
  KEY `projectname_2` (`projectname`)
) ENGINE=InnoDB AUTO_INCREMENT=112413 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `projectstage_old`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `projectstage_old` (
  `id` int NOT NULL AUTO_INCREMENT,
  `projectid` int unsigned NOT NULL,
  `projectstage` enum('Lead','Order','Production','Complete') NOT NULL,
  `projectsubstage` enum('Newlead','Reorder','Ongoing','Unclosed','Design','Proof','Invoice','Submit','Digital','LargeFormat','Outsource','Multistep','Ready','Done','Cancel','Incomplete') NOT NULL,
  `stageduedate` datetime DEFAULT NULL,
  `stageindate` datetime DEFAULT NULL,
  `stageoutdate` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `projectid` (`projectid`),
  KEY `projectid_2` (`projectid`),
  KEY `projectstage` (`projectstage`),
  KEY `projectsubstage` (`projectsubstage`),
  CONSTRAINT `fk_project_projectstage` FOREIGN KEY (`projectid`) REFERENCES `project` (`id`),
  CONSTRAINT `psid` FOREIGN KEY (`projectid`) REFERENCES `project` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=88333 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `projectteammembers_old`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `projectteammembers_old` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `projectid` int unsigned NOT NULL,
  `userid` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `projectid` (`projectid`),
  KEY `puid` (`userid`),
  KEY `projectid_2` (`projectid`),
  KEY `userid` (`userid`),
  KEY `projectid_3` (`projectid`),
  KEY `userid_2` (`userid`),
  CONSTRAINT `ptid` FOREIGN KEY (`projectid`) REFERENCES `project` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `puid` FOREIGN KEY (`userid`) REFERENCES `user` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=293920 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `promo_code`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `promo_code` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(200) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `type` enum('fix','percent') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
  `value` float DEFAULT NULL,
  `valid_from` date DEFAULT NULL,
  `valid_to` date DEFAULT NULL,
  `min_order_price` int DEFAULT NULL,
  `max_order_price` int DEFAULT NULL,
  `multiple_use` tinyint(1) DEFAULT NULL,
  `auto_apply` tinyint(1) NOT NULL DEFAULT '0',
  `used` tinyint(1) DEFAULT NULL,
  `promo_code` varchar(100) NOT NULL,
  `product_ids` json DEFAULT NULL,
  `for_business_category_ids` json DEFAULT NULL,
  `exclude_business_category_ids` json DEFAULT NULL,
  `for_discount_option_ids` json DEFAULT NULL,
  `attach_to_manager_id` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=239 DEFAULT CHARSET=utf8mb3;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `pulse_aggregates`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pulse_aggregates` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `bucket` int unsigned NOT NULL,
  `period` mediumint unsigned NOT NULL,
  `type` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `key` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `key_hash` binary(16) GENERATED ALWAYS AS (unhex(md5(`key`))) VIRTUAL,
  `aggregate` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` decimal(20,2) NOT NULL,
  `count` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `pulse_aggregates_bucket_period_type_aggregate_key_hash_unique` (`bucket`,`period`,`type`,`aggregate`,`key_hash`),
  KEY `pulse_aggregates_period_bucket_index` (`period`,`bucket`),
  KEY `pulse_aggregates_type_index` (`type`),
  KEY `pulse_aggregates_period_type_aggregate_bucket_index` (`period`,`type`,`aggregate`,`bucket`)
) ENGINE=InnoDB AUTO_INCREMENT=23701596 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `pulse_entries`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pulse_entries` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `timestamp` int unsigned NOT NULL,
  `type` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `key` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `key_hash` binary(16) GENERATED ALWAYS AS (unhex(md5(`key`))) VIRTUAL,
  `value` bigint DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `pulse_entries_timestamp_index` (`timestamp`),
  KEY `pulse_entries_type_index` (`type`),
  KEY `pulse_entries_key_hash_index` (`key_hash`),
  KEY `pulse_entries_timestamp_type_key_hash_value_index` (`timestamp`,`type`,`key_hash`,`value`)
) ENGINE=InnoDB AUTO_INCREMENT=5151565 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `pulse_values`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `pulse_values` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `timestamp` int unsigned NOT NULL,
  `type` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `key` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `key_hash` binary(16) GENERATED ALWAYS AS (unhex(md5(`key`))) VIRTUAL,
  `value` mediumtext COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `pulse_values_type_key_hash_unique` (`type`,`key_hash`),
  KEY `pulse_values_timestamp_index` (`timestamp`),
  KEY `pulse_values_type_index` (`type`)
) ENGINE=InnoDB AUTO_INCREMENT=33230 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `purchase_orders`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `purchase_orders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `seller_type` enum('supplier','vendor') NOT NULL,
  `seller_id` int NOT NULL,
  `project_id` int NOT NULL,
  `manager_id` int NOT NULL,
  `ship_date` varchar(255) NOT NULL,
  `items` text NOT NULL,
  `subtotal` varchar(255) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=43 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `qr_scan_history`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `qr_scan_history` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `estimate_id` int NOT NULL,
  `production_step` varchar(100) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `category_id` int DEFAULT NULL,
  `log_id` int NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=59723 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `reactions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `reactions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL,
  `logId` int NOT NULL,
  `userId` int NOT NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=2287 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `search_filters`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `search_filters` (
  `id` int NOT NULL AUTO_INCREMENT,
  `type` enum('project','project_new') NOT NULL DEFAULT 'project',
  `user_id` int NOT NULL,
  `name` varchar(255) NOT NULL,
  `default` tinyint(1) NOT NULL DEFAULT '0',
  `active_users` varchar(255) DEFAULT NULL,
  `manager` varchar(255) DEFAULT NULL,
  `periods` enum('today','tomorrow','two_days','one_week','past_due') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `due_date_from` datetime DEFAULT NULL,
  `due_date_to` datetime DEFAULT NULL,
  `color` varchar(10) DEFAULT NULL,
  `product_ids` json DEFAULT NULL,
  `department_ids` json DEFAULT NULL,
  `show_stage_from` enum('order','prepress','processing','handling','complete') DEFAULT NULL,
  `ordering` enum('stage_in_asc','stage_in_desc','created_asc','created_desc') CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `design_types` json DEFAULT NULL,
  `proofings` json DEFAULT NULL,
  `shipping_methods` json DEFAULT NULL,
  `material_id` int DEFAULT NULL,
  `estimate_types` json DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `user_id_FK` (`user_id`),
  CONSTRAINT `user_id_FK` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=1386 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `search_keywords`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `search_keywords` (
  `id` int NOT NULL AUTO_INCREMENT,
  `client_id` int DEFAULT NULL,
  `keyword` text NOT NULL,
  `navigated_to` varchar(255) DEFAULT NULL,
  `current_page` varchar(255) DEFAULT NULL,
  `created_at` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=93587 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `slideshow_configs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `slideshow_configs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `transition_duration` int DEFAULT NULL,
  `autoplay_speed` int DEFAULT NULL,
  `images` json DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=17 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `suppliers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `suppliers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `company_name` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `contact_name` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `email` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `phone` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `address` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `hours` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `specialty` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `order_key` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=31 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `team`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `team` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(50) NOT NULL,
  `email` varchar(100) DEFAULT NULL,
  `lead_ids` json NOT NULL,
  `members` json DEFAULT NULL,
  `department_id` int NOT NULL,
  `color` varchar(100) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT '#a534b6',
  `printer_folder_id` varchar(200) DEFAULT NULL,
  `printer_folder_name` varchar(200) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `telescope_entries`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `telescope_entries` (
  `sequence` bigint unsigned NOT NULL AUTO_INCREMENT,
  `uuid` char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `batch_id` char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `family_hash` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `should_display_on_index` tinyint(1) NOT NULL DEFAULT '1',
  `type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `content` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime DEFAULT NULL,
  PRIMARY KEY (`sequence`),
  UNIQUE KEY `telescope_entries_uuid_unique` (`uuid`),
  KEY `telescope_entries_batch_id_index` (`batch_id`),
  KEY `telescope_entries_family_hash_index` (`family_hash`),
  KEY `telescope_entries_created_at_index` (`created_at`),
  KEY `telescope_entries_type_should_display_on_index_index` (`type`,`should_display_on_index`)
) ENGINE=InnoDB AUTO_INCREMENT=889853650 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `telescope_entries_tags`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `telescope_entries_tags` (
  `entry_uuid` char(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `tag` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`entry_uuid`,`tag`),
  KEY `telescope_entries_tags_tag_index` (`tag`),
  CONSTRAINT `telescope_entries_tags_entry_uuid_foreign` FOREIGN KEY (`entry_uuid`) REFERENCES `telescope_entries` (`uuid`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `telescope_monitoring`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `telescope_monitoring` (
  `tag` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`tag`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `template_variables`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `template_variables` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `default_value` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=82 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `templates`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `templates` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci NOT NULL,
  `status` enum('active','draft','deleted') CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL DEFAULT 'active',
  `subject` varchar(500) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `email_from` varchar(255) CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci DEFAULT NULL,
  `content` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  `include_signature` tinyint(1) NOT NULL DEFAULT '0',
  `cc_teammembers` tinyint(1) NOT NULL DEFAULT '0',
  `cc_me` tinyint(1) NOT NULL DEFAULT '0',
  `available_for` json DEFAULT NULL,
  `available_for_members` json DEFAULT NULL,
  `additional_receivers` json DEFAULT NULL,
  `cc_to` json DEFAULT NULL,
  `bcc_to` json DEFAULT NULL,
  `used_count` int NOT NULL DEFAULT '0',
  `opened_count` int NOT NULL DEFAULT '0',
  `clicked_count` int NOT NULL DEFAULT '0',
  `available_for_substages` json DEFAULT NULL,
  `type` enum('crm','team') NOT NULL DEFAULT 'team',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=117 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `transactions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `transactions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `referenceid` varchar(255) NOT NULL,
  `transinvoiceid` bigint NOT NULL,
  `transclientid` bigint NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `transemail` varchar(255) NOT NULL,
  `transcompany` varchar(255) NOT NULL,
  `transamount` decimal(10,2) NOT NULL,
  `transstatus` smallint NOT NULL,
  `transdate` datetime NOT NULL,
  `transprojectid` bigint NOT NULL,
  `transtype` enum('partial','full') NOT NULL,
  `transerrormsg` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=16773 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `user`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `user` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(200) DEFAULT NULL,
  `auth_key` varchar(255) DEFAULT NULL,
  `access_token_expired_at` timestamp NULL DEFAULT NULL,
  `password_hash` varchar(255) DEFAULT NULL,
  `password_reset_token` varchar(255) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `personal_email` varchar(255) DEFAULT NULL,
  `unconfirmed_email` varchar(255) DEFAULT NULL,
  `confirmed_at` timestamp NULL DEFAULT NULL,
  `registration_ip` varchar(20) DEFAULT NULL,
  `last_login_at` timestamp NULL DEFAULT NULL,
  `last_login_ip` varchar(20) DEFAULT NULL,
  `blocked_at` timestamp NULL DEFAULT NULL,
  `status` int DEFAULT '10',
  `role` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `name` varchar(100) NOT NULL,
  `last_name` varchar(100) DEFAULT NULL,
  `legal_name` varchar(100) DEFAULT NULL,
  `legal_last_name` varchar(100) DEFAULT NULL,
  `call_rail_name` varchar(150) DEFAULT '',
  `email_name` varchar(150) DEFAULT NULL,
  `extension` varchar(150) DEFAULT '',
  `phone` varchar(150) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT '',
  `phone_country_code` int DEFAULT '1',
  `phone_country_iso` varchar(10) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT 'US',
  `phone_mask` varchar(100) NOT NULL DEFAULT '(000) 000-0000',
  `personal_phone` varchar(255) DEFAULT NULL,
  `personal_phone_country_code` int DEFAULT '1',
  `personal_phone_iso` varchar(10) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT 'US',
  `personal_phone_mask` varchar(100) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT '(000) 000-0000',
  `memberimage` varchar(255) DEFAULT NULL,
  `commission` decimal(8,2) NOT NULL DEFAULT '2.00',
  `haveGmailCredentails` tinyint(1) NOT NULL DEFAULT '0',
  `isSubmitter` tinyint(1) NOT NULL DEFAULT '0',
  `token` longtext,
  `mailSignature` json DEFAULT NULL,
  `view_all_projects` tinyint(1) NOT NULL DEFAULT '1',
  `view_products` tinyint(1) NOT NULL DEFAULT '0',
  `birthday` varchar(255) DEFAULT NULL,
  `working_start_date` datetime DEFAULT CURRENT_TIMESTAMP,
  `title` varchar(100) DEFAULT NULL,
  `type` enum('member','equipment','station','team') NOT NULL DEFAULT 'member',
  PRIMARY KEY (`id`),
  KEY `idx-user` (`username`,`auth_key`,`password_hash`,`status`)
) ENGINE=InnoDB AUTO_INCREMENT=423 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `vendors`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `vendors` (
  `id` int NOT NULL AUTO_INCREMENT,
  `company_name` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `contact_name` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `email` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `phone` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `address` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `hours` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `specialty` varchar(256) CHARACTER SET latin1 COLLATE latin1_swedish_ci DEFAULT NULL,
  `order_key` varchar(256) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=52 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `work_log`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `work_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `project_id` int NOT NULL,
  `estimate_id` int DEFAULT NULL,
  `start_date` datetime NOT NULL,
  `end_date` datetime DEFAULT NULL,
  `duration` bigint DEFAULT NULL,
  `note` text,
  `active` tinyint NOT NULL DEFAULT '1',
  `status` enum('active','paused','stopped') NOT NULL DEFAULT 'stopped',
  `project_current_substage` enum('Newlead','Reorder','Ongoing','Unclosed','Design','Proof','Invoice','Submit','Digital','LargeFormat','Outsource','Multistep','Ready','Done','Cancel','Incomplete') DEFAULT NULL,
  `estimate_current_substage` enum('new_client','reorder','ongoing','follow_up','cad_template','design','tier_1','tier_2','payment','imposition','production','packing','pickup','shipping','delivery_install','job_merge','final_payment','done','canceled','ticket') DEFAULT NULL,
  `created_date` datetime NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=89049 DEFAULT CHARSET=latin1;
/*!40101 SET character_set_client = @saved_cs_client */;
SET @@SESSION.SQL_LOG_BIN = @MYSQLDUMP_TEMP_LOG_BIN;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

