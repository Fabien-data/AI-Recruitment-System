import express from 'express';
import { createPool } from 'mysql2/promise';
import { dbConfig } from './config/database';
import { setRoutes } from './routes/index';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const pool = createPool(dbConfig);

app.locals.pool = pool;

setRoutes(app);

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});