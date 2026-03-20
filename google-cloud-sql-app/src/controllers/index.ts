import { Request, Response } from 'express';

class IndexController {
    public async getAllRecords(req: Request, res: Response): Promise<void> {
        // Logic to retrieve all records from the database
        res.send('Retrieve all records');
    }

    public async createRecord(req: Request, res: Response): Promise<void> {
        // Logic to create a new record in the database
        res.send('Create a new record');
    }
}

export default IndexController;