import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';

export const projectsRouter = Router();

interface Project {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  color: string;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

const memProjects = new Map<string, Project>();

const ProjectBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f59e0b'),
});

projectsRouter.use(requireAuth);

projectsRouter.get('/', (req, res) => {
  const items = [...memProjects.values()].filter((p) => p.userId === req.user!.id && !p.isArchived);
  res.json({ projects: items });
});

projectsRouter.post('/', (req, res, next) => {
  try {
    const body = ProjectBody.parse(req.body);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const project: Project = {
      id,
      userId: req.user!.id,
      name: body.name,
      description: body.description ?? null,
      color: body.color,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    };
    memProjects.set(id, project);
    res.status(201).json({ project });
  } catch (err) {
    next(err);
  }
});

projectsRouter.patch('/:id', (req, res, next) => {
  try {
    const project = memProjects.get(req.params.id);
    if (!project || project.userId !== req.user!.id) throw new HttpError(404, 'not_found', 'Project not found');
    const partial = ProjectBody.partial().parse(req.body);
    const updated: Project = { ...project, ...partial, updatedAt: new Date().toISOString() } as Project;
    memProjects.set(project.id, updated);
    res.json({ project: updated });
  } catch (err) {
    next(err);
  }
});

projectsRouter.delete('/:id', (req, res, next) => {
  try {
    const project = memProjects.get(req.params.id);
    if (!project || project.userId !== req.user!.id) throw new HttpError(404, 'not_found', 'Project not found');
    memProjects.delete(project.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
