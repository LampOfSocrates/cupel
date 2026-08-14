## 2025-05-18 - Database Performance Indexes
**Learning:** Common backend lookup queries (`GET /conversations/{id}/turns`, `GET /turns/{id}/spans`, `GET /evaluations/{id}/judgments`, `GET /admin/conversations?user_id=`) were executing full table scans on SQLite.
**Action:** Always create indexes on foreign key and lookup columns (`turns.conversation_id`, `spans.turn_id`, `judgments.evaluation_id`, `judgments.conversation_id`, `conversations.user_id`) at the end of database schema initialization / migrations.
