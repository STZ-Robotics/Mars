package com.stzteam.mars.models.multimodules;

import com.stzteam.mars.models.singlemodule.Data;

public abstract class CompositeData<T extends CompositeData<T>> extends Data<T> {

}
