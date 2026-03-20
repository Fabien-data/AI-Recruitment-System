import { Router } from 'express';
import IndexController from '../controllers';

const router = Router();
const indexController = new IndexController();

export function setRoutes(app) {
    app.use('/api/records', router);
    router.get('/', indexController.getAllRecords.bind(indexController));
    router.post('/', indexController.createRecord.bind(indexController));
}