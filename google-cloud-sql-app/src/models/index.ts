import { Pool } from 'pg';
import { DatabaseConfig } from '../types';

export class Model {
    private pool: Pool;

    constructor(config: DatabaseConfig) {
        this.pool = new Pool({
            host: config.host,
            user: config.user,
            password: config.password,
            database: config.database,
            port: config.port,
            max: config.poolSize,
        });
    }

    async createRecord(record: any): Promise<any> {
        const query = 'INSERT INTO records(data) VALUES($1) RETURNING *';
        const values = [record];
        const result = await this.pool.query(query, values);
        return result.rows[0];
    }

    async getAllRecords(): Promise<any[]> {
        const query = 'SELECT * FROM records';
        const result = await this.pool.query(query);
        return result.rows;
    }

    async updateRecord(id: number, updatedData: any): Promise<any> {
        const query = 'UPDATE records SET data = $1 WHERE id = $2 RETURNING *';
        const values = [updatedData, id];
        const result = await this.pool.query(query, values);
        return result.rows[0];
    }

    async deleteRecord(id: number): Promise<void> {
        const query = 'DELETE FROM records WHERE id = $1';
        await this.pool.query(query, [id]);
    }
}