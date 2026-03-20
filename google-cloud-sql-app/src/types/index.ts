export interface DatabaseConfig {
    host: string;
    user: string;
    password: string;
    database: string;
    connectionLimit: number;
}

export interface Record {
    id: number;
    name: string;
    value: string;
}